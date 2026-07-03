package com.example.hantech.ui.profile

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.fragment.app.Fragment
import androidx.recyclerview.widget.LinearLayoutManager
import com.example.hantech.auth.Coworker
import com.example.hantech.auth.CoworkerChatStore
import com.example.hantech.auth.CoworkerDirectory
import com.example.hantech.auth.SessionManager
import com.example.hantech.databinding.FragmentCoworkerChatBinding
import com.example.hantech.ui.reflow.ChatAdapter
import com.example.hantech.ui.reflow.ChatMessage

class CoworkerChatFragment : Fragment() {

    private var _binding: FragmentCoworkerChatBinding? = null
    private val binding get() = _binding!!

    private lateinit var chatAdapter: ChatAdapter
    private lateinit var coworker: Coworker
    private var currentUser = ""
    private var messages: List<ChatMessage> = emptyList()

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentCoworkerChatBinding.inflate(inflater, container, false)
        currentUser = SessionManager.currentUser(requireContext()).orEmpty()
        val coworkerId = arguments?.getString(ARG_COWORKER_ID).orEmpty()
        coworker = CoworkerDirectory.items.firstOrNull { it.id == coworkerId } ?: CoworkerDirectory.items.first()

        bindHeader()
        setupChat()
        loadChat()

        return binding.root
    }

    private fun bindHeader() {
        binding.chatAvatarText.text = coworker.name.takeLast(1)
        binding.chatTitleText.text = coworker.name
        binding.coworkerScopeText.text = "${coworker.role} · ${coworker.scope}"
    }

    private fun setupChat() {
        chatAdapter = ChatAdapter()
        binding.coworkerChatRecyclerView.apply {
            adapter = chatAdapter
            layoutManager = LinearLayoutManager(context).apply {
                stackFromEnd = true
            }
        }

        binding.coworkerSendButton.setOnClickListener {
            sendMessage()
        }
        binding.coworkerMessageInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendMessage()
                true
            } else {
                false
            }
        }
    }

    private fun loadChat() {
        messages = CoworkerChatStore.load(requireContext(), currentUser, coworker.id)
        chatAdapter.submitList(messages)
        if (messages.isNotEmpty()) {
            binding.coworkerChatRecyclerView.scrollToPosition(messages.size - 1)
        }
    }

    private fun sendMessage() {
        val content = binding.coworkerMessageInput.text?.toString()?.trim().orEmpty()
        if (content.isBlank()) return

        messages = messages +
            ChatMessage(content = content, isUser = true) +
            ChatMessage(content = "${coworker.name}：${buildReply(content)}", isUser = false)
        CoworkerChatStore.save(requireContext(), currentUser, coworker.id, messages)
        chatAdapter.submitList(messages)
        binding.coworkerMessageInput.text?.clear()
        binding.coworkerChatRecyclerView.scrollToPosition(messages.size - 1)
    }

    private fun buildReply(content: String): String {
        return when {
            content.contains("变桨") || content.contains("电源") -> "先看 24V 供电和驱动器状态，我这边可以配合查历史报警。"
            content.contains("齿轮箱") || content.contains("振动") -> "建议同步 CMS 趋势和油温数据，必要时安排现场复核。"
            content.contains("派工") || content.contains("工单") -> "你把机位、系统和优先级发我，我来协调班组处理。"
            else -> "收到，我先记录一下，现场有报警码或照片也一起发我。"
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    companion object {
        const val ARG_COWORKER_ID = "coworker_id"
    }
}
