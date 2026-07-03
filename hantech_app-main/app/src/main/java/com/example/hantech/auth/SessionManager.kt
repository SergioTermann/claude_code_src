package com.example.hantech.auth

import android.content.Context
import java.security.MessageDigest

object SessionManager {
    private const val PREFS_NAME = "hantech_session"
    private const val KEY_CURRENT_USER = "current_user"
    private const val KEY_CURRENT_NAME = "current_name"
    private const val KEY_USER_PREFIX = "user_"

    fun currentUser(context: Context): String? {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_CURRENT_USER, null)
    }

    fun isLoggedIn(context: Context): Boolean {
        return !currentUser(context).isNullOrBlank()
    }

    fun currentDisplayName(context: Context): String? {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_CURRENT_NAME, null)
    }

    fun saveServerSession(context: Context, username: String, displayName: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_CURRENT_USER, username.trim())
            .putString(KEY_CURRENT_NAME, displayName.ifBlank { username.trim() })
            .apply()
    }

    fun loginOrCreate(context: Context, username: String, password: String): LoginResult {
        val cleanUsername = username.trim()
        if (cleanUsername.length < 2 || password.length < 4) {
            return LoginResult.InvalidInput
        }

        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val userKey = KEY_USER_PREFIX + cleanUsername
        val passwordHash = hashPassword(cleanUsername, password)
        val savedHash = prefs.getString(userKey, null)

        return when {
            savedHash == null -> {
                prefs.edit()
                    .putString(userKey, passwordHash)
                    .putString(KEY_CURRENT_USER, cleanUsername)
                    .apply()
                LoginResult.Created
            }
            savedHash == passwordHash -> {
                prefs.edit()
                    .putString(KEY_CURRENT_USER, cleanUsername)
                    .apply()
                LoginResult.Success
            }
            else -> LoginResult.WrongPassword
        }
    }

    fun logout(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_CURRENT_USER)
            .remove(KEY_CURRENT_NAME)
            .apply()
        WindriseApi.clearSession(context)
    }

    private fun hashPassword(username: String, password: String): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest("$username:$password:hantech-local".toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }
}

sealed class LoginResult {
    data object Success : LoginResult()
    data object Created : LoginResult()
    data object WrongPassword : LoginResult()
    data object InvalidInput : LoginResult()
    data class ServerError(val message: String) : LoginResult()
}
