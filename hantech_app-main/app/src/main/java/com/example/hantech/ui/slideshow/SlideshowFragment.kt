package com.example.hantech.ui.slideshow

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import androidx.fragment.app.Fragment
import com.example.hantech.databinding.FragmentSlideshowBinding

/**
 * 公司技术介绍页面 - 超酷炫版
 * 展示风起时域的核心技术和优势
 * 包含酷炫的进入动画效果
 */
class SlideshowFragment : Fragment() {

    private var _binding: FragmentSlideshowBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentSlideshowBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        
        // 添加酷炫的进入动画
        startAnimations()
    }

    /**
     * 启动酷炫的进入动画
     */
    private fun startAnimations() {
        // 公司名称淡入 + 上滑动画
        binding.companyName.apply {
            alpha = 0f
            translationY = 50f
            animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(600)
                .setStartDelay(200)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .start()
        }

        // 头部卡片淡入动画
        binding.headerCard.apply {
            alpha = 0f
            animate()
                .alpha(1f)
                .setDuration(500)
                .start()
        }

        // 关于我们卡片从左滑入
        binding.aboutCard.apply {
            alpha = 0f
            translationX = -100f
            animate()
                .alpha(1f)
                .translationX(0f)
                .setDuration(600)
                .setStartDelay(300)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .start()
        }

        // 核心技术卡片从右滑入
        binding.techCard.apply {
            alpha = 0f
            translationX = 100f
            animate()
                .alpha(1f)
                .translationX(0f)
                .setDuration(600)
                .setStartDelay(400)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .start()
        }

        // 技术项目依次淡入
        listOf(binding.tech1, binding.tech2, binding.tech3).forEachIndexed { index, card ->
            card.apply {
                alpha = 0f
                translationY = 30f
                animate()
                    .alpha(1f)
                    .translationY(0f)
                    .setDuration(400)
                    .setStartDelay(600L + index * 150L)
                    .setInterpolator(AccelerateDecelerateInterpolator())
                    .start()
            }
        }

        // 优势卡片从左滑入
        binding.advantageCard.apply {
            alpha = 0f
            translationX = -100f
            animate()
                .alpha(1f)
                .translationX(0f)
                .setDuration(600)
                .setStartDelay(1000)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .start()
        }

        // 联系卡片从右滑入
        binding.contactCard.apply {
            alpha = 0f
            translationX = 100f
            animate()
                .alpha(1f)
                .translationX(0f)
                .setDuration(600)
                .setStartDelay(1100)
                .setInterpolator(AccelerateDecelerateInterpolator())
                .start()
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }
}
