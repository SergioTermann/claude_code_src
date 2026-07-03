package com.example.hantech.ui.profile

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.example.hantech.auth.Coworker
import com.example.hantech.databinding.ItemCoworkerBinding

class CoworkerAdapter(
    private val onClick: (Coworker) -> Unit
) : ListAdapter<Coworker, CoworkerAdapter.CoworkerViewHolder>(CoworkerDiffCallback()) {

    private var selectedId: String = ""

    fun select(coworkerId: String) {
        selectedId = coworkerId
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): CoworkerViewHolder {
        val binding = ItemCoworkerBinding.inflate(LayoutInflater.from(parent.context), parent, false)
        return CoworkerViewHolder(binding, onClick)
    }

    override fun onBindViewHolder(holder: CoworkerViewHolder, position: Int) {
        holder.bind(getItem(position), getItem(position).id == selectedId)
    }

    class CoworkerViewHolder(
        private val binding: ItemCoworkerBinding,
        private val onClick: (Coworker) -> Unit
    ) : RecyclerView.ViewHolder(binding.root) {

        fun bind(coworker: Coworker, selected: Boolean) {
            binding.avatarText.text = coworker.name.takeLast(1)
            binding.nameText.text = coworker.name
            binding.roleText.text = "${coworker.role} · ${coworker.scope}"
            binding.lastMessageText.text = coworker.lastMessage
            binding.timeText.text = coworker.time
            binding.unreadText.text = coworker.unreadCount.toString()
            binding.unreadText.visibility = if (coworker.unreadCount > 0) android.view.View.VISIBLE else android.view.View.GONE
            binding.root.alpha = if (selected) 1f else 0.82f
            binding.root.setOnClickListener { onClick(coworker) }
        }
    }

    private class CoworkerDiffCallback : DiffUtil.ItemCallback<Coworker>() {
        override fun areItemsTheSame(oldItem: Coworker, newItem: Coworker): Boolean {
            return oldItem.id == newItem.id
        }

        override fun areContentsTheSame(oldItem: Coworker, newItem: Coworker): Boolean {
            return oldItem == newItem
        }
    }
}
