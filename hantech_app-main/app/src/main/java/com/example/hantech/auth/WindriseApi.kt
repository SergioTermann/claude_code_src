package com.example.hantech.auth

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object WindriseApi {
    private const val PREFS_NAME = "windrise_api"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_SESSION_COOKIE = "session_cookie"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_DISPLAY_NAME = "display_name"
    private const val KEY_IS_ADMIN = "is_admin"

    private val defaultBaseUrls = listOf(
        "https://guise-jiffy-deviant.ngrok-free.dev",
        "http://192.168.5.62:8766",
        "http://10.0.2.2:8766",
    )

    fun baseUrl(context: Context): String {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_BASE_URL, defaultBaseUrls.first())
            .orEmpty()
            .trimEnd('/')
            .ifBlank { defaultBaseUrls.first() }
    }

    fun setBaseUrl(context: Context, value: String) {
        val normalized = normalizeBaseUrl(value)
        if (normalized.isBlank()) return
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_BASE_URL, normalized)
            .apply()
    }

    fun serverOptions(context: Context): List<String> {
        return (listOf(baseUrl(context)) + defaultBaseUrls).distinct()
    }

    fun sessionCookie(context: Context): String {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_SESSION_COOKIE, "")
            .orEmpty()
    }

    fun currentServerProfile(context: Context): ServerProfile? {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val userId = prefs.getString(KEY_USER_ID, "").orEmpty()
        val username = SessionManager.currentUser(context).orEmpty()
        if (username.isBlank() || userId.isBlank()) return null
        return ServerProfile(
            userId = userId,
            username = username,
            displayName = prefs.getString(KEY_DISPLAY_NAME, username).orEmpty(),
            isAdmin = prefs.getBoolean(KEY_IS_ADMIN, false),
        )
    }

    fun clearSession(context: Context) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(KEY_SESSION_COOKIE)
            .remove(KEY_USER_ID)
            .remove(KEY_DISPLAY_NAME)
            .remove(KEY_IS_ADMIN)
            .apply()
    }

    suspend fun login(context: Context, username: String, password: String): LoginResult = withContext(Dispatchers.IO) {
        val cleanUsername = username.trim()
        if (cleanUsername.isBlank() || password.isBlank()) {
            return@withContext LoginResult.InvalidInput
        }

        var lastError = ""
        for (baseUrl in serverOptions(context)) {
            try {
                val response = postJson(
                    url = "$baseUrl/api/login",
                    payload = JSONObject()
                        .put("username", cleanUsername)
                        .put("password", password),
                    cookie = "",
                )
                val body = JSONObject(response.body)
                if (!body.optBoolean("success", false)) {
                    lastError = body.optString("error", "登录失败")
                    continue
                }

                val displayName = body.optString("name", cleanUsername).ifBlank { cleanUsername }
                context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_BASE_URL, baseUrl)
                    .putString(KEY_SESSION_COOKIE, response.cookie)
                    .putString(KEY_USER_ID, body.optString("user_id", ""))
                    .putString(KEY_DISPLAY_NAME, displayName)
                    .putBoolean(KEY_IS_ADMIN, body.optBoolean("is_admin", false))
                    .apply()
                SessionManager.saveServerSession(context, cleanUsername, displayName)
                return@withContext LoginResult.Success
            } catch (exception: Exception) {
                if (exception is ApiException && (exception.status == 401 || exception.status == 403)) {
                    return@withContext LoginResult.ServerError(exception.message.orEmpty().ifBlank { "用户名或密码错误" })
                }
                lastError = exception.message.orEmpty()
            }
        }
        return@withContext LoginResult.ServerError(lastError.ifBlank { "无法连接 Windrise 服务" })
    }

    fun postApi(context: Context, path: String, payload: JSONObject): ApiResponse {
        val baseUrl = baseUrl(context)
        return postJson(
            url = "$baseUrl$path",
            payload = payload,
            cookie = sessionCookie(context),
        )
    }

    private fun postJson(url: String, payload: JSONObject, cookie: String): ApiResponse {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 5_000
            readTimeout = 90_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
            if (cookie.isNotBlank()) {
                setRequestProperty("Cookie", cookie)
            }
        }

        OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer ->
            writer.write(payload.toString())
        }

        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
        val cookieHeader = connection.getHeaderField("Set-Cookie").orEmpty()
        connection.disconnect()

        if (status !in 200..299) {
            val error = runCatching { JSONObject(body).optString("error") }.getOrNull()
                ?.ifBlank { null }
            if (status == 401 || status == 403) {
                throw ApiException(status, error ?: "登录已失效，请重新登录")
            }
            throw ApiException(status, error ?: "HTTP $status")
        }

        return ApiResponse(
            body = body,
            cookie = cookieHeader.substringBefore(';').ifBlank { cookie },
        )
    }

    private fun normalizeBaseUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        if (trimmed.isBlank()) return ""
        return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            trimmed
        } else {
            "http://$trimmed"
        }
    }
}

data class ApiResponse(
    val body: String,
    val cookie: String,
)

data class ServerProfile(
    val userId: String,
    val username: String,
    val displayName: String,
    val isAdmin: Boolean,
)

private class ApiException(
    val status: Int,
    message: String,
) : IllegalStateException(message)
