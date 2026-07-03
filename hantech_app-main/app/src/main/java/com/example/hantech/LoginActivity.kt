package com.example.hantech

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.example.hantech.auth.LoginResult
import com.example.hantech.auth.SessionManager
import com.example.hantech.auth.WindriseApi
import com.example.hantech.databinding.ActivityLoginBinding
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (SessionManager.isLoggedIn(this) && WindriseApi.currentServerProfile(this) != null) {
            openMain()
            return
        }
        if (SessionManager.isLoggedIn(this)) {
            SessionManager.logout(this)
        }

        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.serverAddressInput.setText(WindriseApi.baseUrl(this))

        binding.loginButton.setOnClickListener {
            val username = binding.usernameInput.text?.toString().orEmpty()
            val password = binding.passwordInput.text?.toString().orEmpty()
            val serverAddress = binding.serverAddressInput.text?.toString().orEmpty()
            WindriseApi.setBaseUrl(this, serverAddress)
            login(username, password)
        }
    }

    private fun login(username: String, password: String) {
        binding.loginButton.isEnabled = false
        binding.loginButton.text = "正在登录..."
        lifecycleScope.launch {
            val result = WindriseApi.login(this@LoginActivity, username, password)
            binding.loginButton.isEnabled = true
            binding.loginButton.text = "登录系统账号"
            when (result) {
                LoginResult.Success -> openMain()
                LoginResult.Created -> openMain()
                LoginResult.WrongPassword -> Toast.makeText(this@LoginActivity, "密码不正确", Toast.LENGTH_SHORT).show()
                LoginResult.InvalidInput -> Toast.makeText(this@LoginActivity, "请输入账号和密码", Toast.LENGTH_SHORT).show()
                is LoginResult.ServerError -> {
                    Toast.makeText(
                        this@LoginActivity,
                        result.message.ifBlank { "登录失败，请检查服务或账号" },
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }
    }

    private fun openMain() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
