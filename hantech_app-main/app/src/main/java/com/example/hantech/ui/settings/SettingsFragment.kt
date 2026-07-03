package com.example.hantech.ui.settings

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import com.example.hantech.LoginActivity
import com.example.hantech.auth.SessionManager
import com.example.hantech.auth.WindriseApi
import com.example.hantech.databinding.FragmentSettingsBinding

class SettingsFragment : Fragment() {

    private var _binding: FragmentSettingsBinding? = null

    // This property is only valid between onCreateView and
    // onDestroyView.
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        val settingsViewModel =
            ViewModelProvider(this).get(SettingsViewModel::class.java)

        _binding = FragmentSettingsBinding.inflate(inflater, container, false)
        val root: View = binding.root

        val textView: TextView = binding.textSettings
        settingsViewModel.text.observe(viewLifecycleOwner) {
            textView.text = it
        }

        val profile = WindriseApi.currentServerProfile(requireContext())
        binding.accountStatusText.text = if (profile == null) {
            "未读取到服务端会话，请重新登录"
        } else {
            val role = if (profile.isAdmin) "管理员" else "普通用户"
            "${profile.displayName}（${profile.username}） · $role"
        }
        binding.serverAddressText.text = WindriseApi.baseUrl(requireContext())

        binding.logoutButton.setOnClickListener {
            SessionManager.logout(requireContext())
            startActivity(Intent(requireContext(), LoginActivity::class.java))
            requireActivity().finish()
        }
        return root
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
