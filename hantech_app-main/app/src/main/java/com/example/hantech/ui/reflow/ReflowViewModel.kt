package com.example.hantech.ui.reflow

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch

/**
 * 聊天界面 ViewModel
 * 管理聊天消息列表和发送逻辑
 */
class ReflowViewModel : ViewModel() {
    private val windriseClient = WindriseClient()
    private var conversationId: String = ""

    // 聊天消息列表
    private val _messages = MutableLiveData<List<ChatMessage>>(emptyList())
    val messages: LiveData<List<ChatMessage>> = _messages

    // 是否正在发送消息
    private val _isSending = MutableLiveData<Boolean>(false)
    val isSending: LiveData<Boolean> = _isSending

    fun setMessages(messages: List<ChatMessage>) {
        _messages.value = messages
    }

    /**
     * 发送用户消息
     * @param content 消息内容
     */
    fun sendMessage(context: Context, content: String) {
        if (content.isBlank() || _isSending.value == true) return

        // 添加用户消息
        val userMessage = ChatMessage(content = content.trim(), isUser = true)
        addMessage(userMessage)

        _isSending.value = true
        viewModelScope.launch {
            try {
                val aiResponse = runCatching {
                    val reply = windriseClient.ask(context.applicationContext, content.trim(), conversationId)
                    if (reply.conversationId.isNotBlank()) {
                        conversationId = reply.conversationId
                    }
                    reply.answer
                }.getOrElse {
                    val message = it.message.orEmpty()
                    if (message.contains("登录", ignoreCase = true) || message.contains("401") || message.contains("403")) {
                        return@getOrElse "登录状态已失效，请退出后重新登录系统账号。"
                    }
                    generateFallbackResponse(content)
                }.ifBlank {
                    generateFallbackResponse(content)
                }
                val aiMessage = ChatMessage(content = aiResponse, isUser = false)
                addMessage(aiMessage)
            } finally {
                _isSending.value = false
            }
        }
    }

    /**
     * 添加消息到列表
     */
    private fun addMessage(message: ChatMessage) {
        val currentMessages = _messages.value ?: emptyList()
        _messages.value = currentMessages + message
    }

    /**
     * Windrise 服务不可用时的本地兜底回复。
     */
    private fun generateFallbackResponse(userInput: String): String {
        val normalized = userInput.trim()
        val code = Regex("""\b[A-Za-z]?_?\d{3,8}[A-Za-z]?\b""").find(normalized)?.value
        return when {
            isGreeting(normalized) ->
                "你好，我是 Windrise 风电运维助手。你可以直接问故障码、原理机理，也可以发现场现象让我判断下一步。"

            code != null && !isFieldActionQuery(normalized) ->
                buildFaultCodeLookupFallback(code)

            isPrincipleQuery(normalized) ->
                buildPrincipleFallback(normalized)

            isFieldActionQuery(normalized) ->
                buildFieldActionFallback(normalized)
            
            userInput.contains("风起时域", ignoreCase = true) -> 
                "Windrise 面向风电现场运维，支持故障码查询、机理问答、现场处置建议、工单整理和协同沟通。"
            
            userInput.contains("工单", ignoreCase = true) ->
                """
                可以。为了少让现场人员填表，我只需要以下信息里能提供的部分：

                1. 机位号或风场
                2. 报警码/系统部件/现场现象
                3. 是否停机、是否可远程复位
                4. 已做过的检查或照片备注

                信息不全也可以先开单，缺失项会标记为待确认。你可以直接发一句现场描述。
                """.trimIndent()

            userInput.contains("变桨", ignoreCase = true) || userInput.contains("24V", ignoreCase = true) ->
                "变桨系统常见关注点包括 24V/400V 供电、驱动器状态、后备电源、编码器反馈、限位信号和桨叶角度。若你要现场处理，请补充报警码或现象，我会只给下一步动作。"

            userInput.contains("齿轮箱", ignoreCase = true) || userInput.contains("振动", ignoreCase = true) ->
                "齿轮箱相关问题通常要结合油温、轴承温度、油位、滤芯压差、CMS 趋势和异响位置判断。若你问“怎么办”，我会按导航式只给一个下一步动作。"
            
            userInput.contains("帮助", ignoreCase = true) || 
            userInput.contains("help", ignoreCase = true) -> 
                "我可以协助报警分析、检修步骤、备件工具建议、工单描述整理和派工沟通。现场人员可以少填字段，直接描述现象。"
            
            userInput.contains("功能", ignoreCase = true) || 
            userInput.contains("能做什么", ignoreCase = true) -> 
                "当前主要支持：现场问答、报警风险判断、检修步骤建议、工单结构化整理、PDF 工单转发和同事协同对话。"
            
            userInput.length < 3 -> 
                "请补充机位、报警码或现场现象。只写一句话也可以。"
            
            else -> 
                "收到：$userInput\n\n如果是查询类问题，我可以直接解释含义或原理；如果是现场处置问题，请补充“怎么处理/下一步”，我会按导航式给一个明确动作。"
        }
    }

    private fun isGreeting(text: String): Boolean {
        val cleaned = text.lowercase()
        return cleaned in setOf("你好", "您好", "hello", "hi", "嗨")
    }

    private fun isFieldActionQuery(text: String): Boolean {
        val keywords = listOf(
            "怎么办", "怎么处理", "如何处理", "处理方法", "处置", "排查", "检查",
            "检修", "维修", "下一步", "接下来", "继续", "后续", "怎么修", "我该怎么做"
        )
        return keywords.any { text.contains(it, ignoreCase = true) }
    }

    private fun isPrincipleQuery(text: String): Boolean {
        val keywords = listOf(
            "原理", "机理", "机制", "工作方式", "工作过程", "运行逻辑", "控制逻辑",
            "怎么工作", "如何工作", "为什么", "作用", "结构", "组成", "解释一下"
        )
        return keywords.any { text.contains(it, ignoreCase = true) }
    }

    private fun buildFaultCodeLookupFallback(code: String): String {
        return """
            结论：已识别为故障码查询：$code。

            当前 App 未连上 Windrise 知识库服务，无法返回该码的准确名称、复位方式和来源。

            请确认手机能访问 Windrise 服务后重试；如果在模拟器调试，请确认电脑端 8766 服务已开启。
        """.trimIndent()
    }

    private fun buildPrincipleFallback(text: String): String {
        return when {
            text.contains("偏航", ignoreCase = true) && text.contains("液压", ignoreCase = true) ->
                """
                    偏航液压系统的作用，是在偏航动作前后控制偏航制动器的夹紧和释放。

                    基本过程是：液压站建立压力，电磁阀控制油路通断，蓄能器稳定压力，制动器按控制指令释放或抱闸。系统会通过压力开关、压力传感器和 PLC 输入信号判断压力是否到位。

                    如果问现场怎么处理，需要补充具体告警码、压力值、建压时间和电机动作次数。
                """.trimIndent()

            text.contains("齿轮箱", ignoreCase = true) ->
                """
                    齿轮箱温度主要由负载、润滑、散热和测温链路共同决定。

                    正常情况下，油泵保证润滑油循环，滤芯保持油液清洁，油冷系统把热量带走，温度传感器把油温或轴承温度反馈给主控。

                    如果问“过热怎么办”，应进入现场处置模式，先确认油冷散热是否有效。
                """.trimIndent()

            else ->
                "这是原理/机理类问题。当前 Windrise 服务未连上，我先按通用工程逻辑回答：请补充具体系统或部件名称，我可以解释它的组成、信号链路、控制逻辑和常见失效方式。"
        }
    }

    private fun buildFieldActionFallback(text: String): String {
        return when {
            text.contains("齿轮箱", ignoreCase = true) && (
                text.contains("过热", ignoreCase = true) ||
                    text.contains("过温", ignoreCase = true) ||
                    text.contains("温度高", ignoreCase = true)
                ) ->
                """
                    结论：先按齿轮箱真实温升处理，不要先等故障码。

                    下一步只做一件事：确认油冷散热是否有效，检查油冷风扇或水冷回路是否运行，并记录当前齿轮箱油温。

                    请反馈：油冷系统是否运行，以及当前油温数值。
                """.trimIndent()

            text.contains("偏航", ignoreCase = true) && text.contains("压力", ignoreCase = true) ->
                """
                    结论：先按偏航回路建压异常处理，暂不直接拆阀或换泵。

                    下一步只做一件事：手动释放刹车，再恢复刹车，记录压力恢复过程。

                    请反馈：最低压力、恢复到 150bar 用时、液压站电机动作次数。
                """.trimIndent()

            else ->
                """
                    结论：当前信息不足，先不要直接换件。

                    下一步只做一件事：在 SCADA 或 HMI 上确认原始告警码、告警全称和当前设备状态。

                    请反馈：告警码、告警名称、是否停机、是否可复位。
                """.trimIndent()
        }
    }

    /**
     * 清空聊天记录
     */
    fun clearMessages() {
        _messages.value = emptyList()
    }
}
