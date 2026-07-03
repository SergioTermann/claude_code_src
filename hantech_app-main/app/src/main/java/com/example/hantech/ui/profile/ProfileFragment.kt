package com.example.hantech.ui.profile

import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import androidx.navigation.fragment.findNavController
import androidx.recyclerview.widget.LinearLayoutManager
import com.example.hantech.R
import com.example.hantech.auth.Coworker
import com.example.hantech.auth.CoworkerChatStore
import com.example.hantech.auth.CoworkerDirectory
import com.example.hantech.auth.ProfileStore
import com.example.hantech.auth.SessionManager
import com.example.hantech.auth.UserProfile
import com.example.hantech.databinding.FragmentProfileBinding

class ProfileFragment : Fragment() {

    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!

    private lateinit var coworkerAdapter: CoworkerAdapter
    private var currentUser = ""
    private var avatarUri: String = ""

    private val avatarPicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            requireContext().contentResolver.takePersistableUriPermissionSafe(uri)
            avatarUri = uri.toString()
            bindAvatar(avatarUri, binding.displayNameInput.text?.toString().orEmpty())
            saveProfile(showToast = false)
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        currentUser = SessionManager.currentUser(requireContext()).orEmpty()

        setupProfile()
        setupCoworkers()

        return binding.root
    }

    private fun setupProfile() {
        val profile = ProfileStore.load(requireContext(), currentUser)
        avatarUri = profile.avatarUri
        bindAvatar(profile.avatarUri, profile.displayName)
        bindProfileHeader(profile.displayName, profile.team)
        binding.displayNameInput.setText(profile.displayName)
        binding.roleInput.setText(profile.role)
        binding.teamInput.setText(profile.team)
        binding.stationInput.setText(profile.station)

        binding.profileAvatarContainer.setOnClickListener {
            avatarPicker.launch("image/*")
        }
        binding.changeAvatarButton.setOnClickListener {
            avatarPicker.launch("image/*")
        }
        binding.saveProfileButton.setOnClickListener {
            saveProfile(showToast = true)
        }
    }

    private fun setupCoworkers() {
        coworkerAdapter = CoworkerAdapter { coworker ->
            findNavController().navigate(
                R.id.nav_coworker_chat,
                bundleOf(CoworkerChatFragment.ARG_COWORKER_ID to coworker.id)
            )
        }
        binding.coworkerListRecyclerView.apply {
            adapter = coworkerAdapter
            layoutManager = LinearLayoutManager(context)
        }
        coworkerAdapter.submitList(buildCoworkerList())
    }

    private fun buildCoworkerList(): List<Coworker> {
        return CoworkerDirectory.items.map { coworker ->
            val messages = CoworkerChatStore.load(requireContext(), currentUser, coworker.id)
            val lastMessage = messages.lastOrNull()
            if (lastMessage == null) {
                coworker
            } else {
                coworker.copy(
                    lastMessage = when {
                        lastMessage.attachmentName.isNotBlank() -> "PDF：${lastMessage.attachmentName}"
                        lastMessage.content.length > 26 -> lastMessage.content.take(26) + "..."
                        else -> lastMessage.content
                    },
                    time = "最近",
                    unreadCount = if (lastMessage.isUser) 0 else coworker.unreadCount
                )
            }
        }
    }

    private fun saveProfile(showToast: Boolean) {
        val profile = UserProfile(
            displayName = binding.displayNameInput.text?.toString().orEmpty(),
            role = binding.roleInput.text?.toString().orEmpty(),
            team = binding.teamInput.text?.toString().orEmpty(),
            station = binding.stationInput.text?.toString().orEmpty(),
            avatarUri = avatarUri
        )
        ProfileStore.save(requireContext(), currentUser, profile)
        bindAvatar(profile.avatarUri, profile.displayName)
        bindProfileHeader(profile.displayName, profile.team)
        if (showToast) {
            Toast.makeText(requireContext(), "个人设定已保存", Toast.LENGTH_SHORT).show()
        }
    }

    private fun bindProfileHeader(displayName: String, team: String) {
        binding.profileNameText.text = displayName.ifBlank { currentUser }
        binding.accountText.text = "$currentUser · ${team.ifBlank { "未设置班组" }}"
    }

    private fun bindAvatar(uri: String, displayName: String) {
        if (uri.isNotBlank()) {
            binding.profileAvatarImage.setImageURI(Uri.parse(uri))
            binding.profileAvatarImage.visibility = View.VISIBLE
            binding.profileAvatarText.visibility = View.GONE
        } else {
            binding.profileAvatarImage.visibility = View.GONE
            binding.profileAvatarText.visibility = View.VISIBLE
            binding.profileAvatarText.text = displayName.takeLast(1).ifBlank { currentUser.take(1) }
        }
    }

    private fun android.content.ContentResolver.takePersistableUriPermissionSafe(uri: Uri) {
        runCatching {
            takePersistableUriPermission(uri, android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
