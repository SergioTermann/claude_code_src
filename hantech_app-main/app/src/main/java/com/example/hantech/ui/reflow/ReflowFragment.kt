package com.example.hantech.ui.reflow

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import androidx.recyclerview.widget.LinearLayoutManager
import com.example.hantech.auth.ChatHistoryStore
import com.example.hantech.auth.SessionManager
import com.example.hantech.databinding.FragmentReflowBinding

/**
 * 大模型问答界面 Fragment
 * 提供聊天交互功能
 */
class ReflowFragment : Fragment() {

    private var _binding: FragmentReflowBinding? = null
    private val binding get() = _binding!!
    
    private lateinit var viewModel: ReflowViewModel
    private lateinit var chatAdapter: ChatAdapter
    private var currentUser: String = ""

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentReflowBinding.inflate(inflater, container, false)
        viewModel = ViewModelProvider(this)[ReflowViewModel::class.java]
        currentUser = SessionManager.currentUser(requireContext()).orEmpty()
        
        setupRecyclerView()
        setupInputArea()
        loadUserHistory()
        observeViewModel()
        
        return binding.root
    }

    /**
     * 设置 RecyclerView
     */
    private fun setupRecyclerView() {
        chatAdapter = ChatAdapter()
        binding.chatRecyclerView.apply {
            adapter = chatAdapter
            layoutManager = LinearLayoutManager(context).apply {
                // 从底部开始布局，新消息在底部
                stackFromEnd = true
            }
        }
    }

    /**
     * 设置输入区域
     */
    private fun setupInputArea() {
        // 发送按钮点击事件
        binding.sendButton.setOnClickListener {
            sendMessage()
        }

        binding.quickAlarmPromptButton.setOnClickListener {
            sendQuickPrompt("70001是什么故障")
        }

        binding.quickWorkOrderPromptButton.setOnClickListener {
            sendQuickPrompt("偏航液压系统的工作原理是什么")
        }

        binding.quickChecklistPromptButton.setOnClickListener {
            sendQuickPrompt("齿轮箱过热了怎么办")
        }

        // 输入框回车发送
        binding.messageInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendMessage()
                true
            } else {
                false
            }
        }
    }

    private fun sendQuickPrompt(prompt: String) {
        if (viewModel.isSending.value == true) return
        viewModel.sendMessage(requireContext(), prompt)
    }

    /**
     * 观察 ViewModel 数据变化
     */
    private fun observeViewModel() {
        // 观察消息列表
        viewModel.messages.observe(viewLifecycleOwner) { messages ->
            chatAdapter.submitList(messages)
            if (currentUser.isNotBlank()) {
                ChatHistoryStore.save(requireContext(), currentUser, messages)
            }
            
            // 更新空状态显示
            binding.emptyStateLayout.visibility = 
                if (messages.isEmpty()) View.VISIBLE else View.GONE
            
            // 滚动到最新消息
            if (messages.isNotEmpty()) {
                binding.chatRecyclerView.scrollToPosition(messages.size - 1)
            }
        }

        // 观察发送状态
        viewModel.isSending.observe(viewLifecycleOwner) { isSending ->
            // 发送中禁用输入
            binding.messageInput.isEnabled = !isSending
            binding.sendButton.isEnabled = !isSending
            
            // 显示加载状态和动画效果
            binding.sendButton.alpha = if (isSending) 0.5f else 1.0f
            
            // 发送中时旋转按钮
            if (isSending) {
                binding.sendButton.animate().rotation(360f).setDuration(500).start()
            } else {
                binding.sendButton.rotation = 0f
            }
        }
    }

    /**
     * 发送消息
     */
    private fun sendMessage() {
        val content = binding.messageInput.text?.toString() ?: ""
        if (content.isNotBlank()) {
            viewModel.sendMessage(requireContext(), content)
            binding.messageInput.text?.clear()
        }
    }

    private fun loadUserHistory() {
        if (currentUser.isNotBlank()) {
            viewModel.setMessages(ChatHistoryStore.load(requireContext(), currentUser))
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
