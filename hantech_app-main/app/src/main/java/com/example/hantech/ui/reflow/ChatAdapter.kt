package com.example.hantech.ui.reflow

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import android.widget.TextView
import androidx.core.content.FileProvider
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.example.hantech.R
import java.io.File

/**
 * 聊天消息适配器
 * 使用 ListAdapter 自动处理列表更新
 */
class ChatAdapter : ListAdapter<ChatMessage, ChatAdapter.MessageViewHolder>(MessageDiffCallback()) {

    /**
     * 消息 ViewHolder
     * 根据消息类型显示不同的布局
     */
    class MessageViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val userMessageContainer: View = itemView.findViewById(R.id.userMessageContainer)
        private val aiMessageContainer: View = itemView.findViewById(R.id.aiMessageContainer)
        private val userMessageText: TextView = itemView.findViewById(R.id.userMessageText)
        private val aiMessageText: TextView = itemView.findViewById(R.id.aiMessageText)
        private val userAttachmentText: TextView = itemView.findViewById(R.id.userAttachmentText)
        private val aiAttachmentText: TextView = itemView.findViewById(R.id.aiAttachmentText)

        /**
         * 绑定消息数据
         */
        fun bind(message: ChatMessage) {
            if (message.isUser) {
                // 显示用户消息
                userMessageContainer.visibility = View.VISIBLE
                aiMessageContainer.visibility = View.GONE
                userMessageText.text = message.content
                bindAttachment(userAttachmentText, message)
            } else {
                // 显示 AI 消息
                userMessageContainer.visibility = View.GONE
                aiMessageContainer.visibility = View.VISIBLE
                aiMessageText.text = message.content
                bindAttachment(aiAttachmentText, message)
            }
        }

        private fun bindAttachment(attachmentView: TextView, message: ChatMessage) {
            if (message.attachmentName.isBlank()) {
                attachmentView.visibility = View.GONE
                attachmentView.setOnClickListener(null)
            } else {
                attachmentView.visibility = View.VISIBLE
                attachmentView.text = "PDF\n${message.attachmentName}\n点击打开"
                attachmentView.setOnClickListener {
                    openPdfAttachment(attachmentView, message)
                }
            }
        }

        private fun openPdfAttachment(view: View, message: ChatMessage) {
            val file = File(message.attachmentPath)
            if (!file.exists()) {
                Toast.makeText(view.context, "附件文件不存在", Toast.LENGTH_SHORT).show()
                return
            }

            val uri: Uri = FileProvider.getUriForFile(
                view.context,
                "${view.context.packageName}.fileprovider",
                file
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/pdf")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }

            try {
                view.context.startActivity(Intent.createChooser(intent, "打开 PDF"))
            } catch (exception: ActivityNotFoundException) {
                Toast.makeText(view.context, "未找到可打开 PDF 的应用", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): MessageViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_chat_message, parent, false)
        return MessageViewHolder(view)
    }

    override fun onBindViewHolder(holder: MessageViewHolder, position: Int) {
        holder.bind(getItem(position))
    }

    /**
     * DiffUtil 回调，用于高效更新列表
     */
    private class MessageDiffCallback : DiffUtil.ItemCallback<ChatMessage>() {
        override fun areItemsTheSame(oldItem: ChatMessage, newItem: ChatMessage): Boolean {
            return oldItem.timestamp == newItem.timestamp
        }

        override fun areContentsTheSame(oldItem: ChatMessage, newItem: ChatMessage): Boolean {
            return oldItem == newItem
        }
    }
}
