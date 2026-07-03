package com.example.hantech.auth

import android.content.Context

object ProfileStore {
    private const val PREFS_NAME = "hantech_profiles"

    fun load(context: Context, username: String): UserProfile {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        return UserProfile(
            displayName = prefs.getString("${username}_name", username).orEmpty(),
            role = prefs.getString("${username}_role", "风机运维工程师").orEmpty(),
            team = prefs.getString("${username}_team", "A 班组").orEmpty(),
            station = prefs.getString("${username}_station", "新华风电场").orEmpty(),
            avatarUri = prefs.getString("${username}_avatar", "").orEmpty()
        )
    }

    fun save(context: Context, username: String, profile: UserProfile) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("${username}_name", profile.displayName)
            .putString("${username}_role", profile.role)
            .putString("${username}_team", profile.team)
            .putString("${username}_station", profile.station)
            .putString("${username}_avatar", profile.avatarUri)
            .apply()
    }
}

data class UserProfile(
    val displayName: String,
    val role: String,
    val team: String,
    val station: String,
    val avatarUri: String = ""
)
