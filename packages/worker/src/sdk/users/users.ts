import env from "../../environment"
import { quotas } from "@budibase/pro"
import * as apps from "../../utilities/appService"
const { events } = require("@budibase/backend-core")
import * as eventHelpers from "./events"

const {
  tenancy,
  accounts,
  utils,
  db: dbUtils,
  constants,
  cache,
  users: usersCore,
  deprovisioning,
  sessions,
  HTTPError,
} = require("@budibase/backend-core")

/**
 * Retrieves all users from the current tenancy.
 */
export const allUsers = async () => {
  const db = tenancy.getGlobalDB()
  const response = await db.allDocs(
    dbUtils.getGlobalUserParams(null, {
      include_docs: true,
    })
  )
  return response.rows.map((row: any) => row.doc)
}

/**
 * Gets a user by ID from the global database, based on the current tenancy.
 */
export const getUser = async (userId: string) => {
  const db = tenancy.getGlobalDB()
  let user
  try {
    user = await db.get(userId)
  } catch (err: any) {
    // no user found, just return nothing
    if (err.status === 404) {
      return {}
    }
    throw err
  }
  if (user) {
    delete user.password
  }
  return user
}

export const save = async (
  user: any,
  hashPassword = true,
  requirePassword = true
) => {
  const tenantId = tenancy.getTenantId()

  // specify the tenancy incase we're making a new admin user (public)
  const db = tenancy.getGlobalDB(tenantId)
  let { email, password, _id } = user
  // make sure another user isn't using the same email
  let dbUser
  if (email) {
    // check budibase users inside the tenant
    dbUser = await usersCore.getGlobalUserByEmail(email)
    if (dbUser != null && (dbUser._id !== _id || Array.isArray(dbUser))) {
      throw `Email address ${email} already in use.`
    }

    // check budibase users in other tenants
    if (env.MULTI_TENANCY) {
      const tenantUser = await tenancy.getTenantUser(email)
      if (tenantUser != null && tenantUser.tenantId !== tenantId) {
        throw `Email address ${email} already in use.`
      }
    }

    // check root account users in account portal
    if (!env.SELF_HOSTED && !env.DISABLE_ACCOUNT_PORTAL) {
      const account = await accounts.getAccount(email)
      if (account && account.verified && account.tenantId !== tenantId) {
        throw `Email address ${email} already in use.`
      }
    }
  } else if (_id) {
    dbUser = await db.get(_id)
  }

  // get the password, make sure one is defined
  let hashedPassword
  if (password) {
    hashedPassword = hashPassword ? await utils.hash(password) : password
  } else if (dbUser) {
    hashedPassword = dbUser.password
  } else if (requirePassword) {
    throw "Password must be specified."
  }

  if (!_id) {
    _id = dbUtils.generateGlobalUserID(email)
  }

  user = {
    createdAt: Date.now(),
    ...dbUser,
    ...user,
    _id,
    password: hashedPassword,
    tenantId,
  }
  // make sure the roles object is always present
  if (!user.roles) {
    user.roles = {}
  }
  // add the active status to a user if its not provided
  if (user.status == null) {
    user.status = constants.UserStatus.ACTIVE
  }
  try {
    // save the user to db
    let response
    const putUserFn = () => {
      return db.put(user)
    }
    if (await eventHelpers.isAddingBuilder(user, dbUser)) {
      response = await quotas.addDeveloper(putUserFn)
    } else {
      response = await putUserFn()
    }

    eventHelpers.handleSaveEvents(user, dbUser)

    await tenancy.tryAddTenant(tenantId, _id, email)
    await cache.user.invalidateUser(response.id)
    // let server know to sync user
    await apps.syncUserInApps(user._id)

    return {
      _id: response.id,
      _rev: response.rev,
      email,
    }
  } catch (err: any) {
    if (err.status === 409) {
      throw "User exists already"
    } else {
      throw err
    }
  }
}

export const destroy = async (id: string, currentUser: any) => {
  const db = tenancy.getGlobalDB()
  const dbUser = await db.get(id)

  if (!env.SELF_HOSTED && !env.DISABLE_ACCOUNT_PORTAL) {
    // root account holder can't be deleted from inside budibase
    const email = dbUser.email
    const account = await accounts.getAccount(email)
    if (account) {
      if (email === currentUser.email) {
        throw new HTTPError('Please visit "Account" to delete this user', 400)
      } else {
        throw new HTTPError("Account holder cannot be deleted", 400)
      }
    }
  }

  await deprovisioning.removeUserFromInfoDB(dbUser)
  await db.remove(dbUser._id, dbUser._rev)
  eventHelpers.handleDeleteEvents(dbUser)
  await quotas.removeUser(dbUser)
  await cache.user.invalidateUser(dbUser._id)
  await sessions.invalidateSessions(dbUser._id)
  // let server know to sync user
  await apps.syncUserInApps(dbUser._id)
}