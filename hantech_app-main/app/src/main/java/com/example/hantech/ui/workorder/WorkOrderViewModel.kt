package com.example.hantech.ui.workorder

import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class WorkOrderViewModel : ViewModel() {

    private val _generatedWorkOrder = MutableLiveData<String>()
    val generatedWorkOrder: LiveData<String> = _generatedWorkOrder

    private val _isGenerating = MutableLiveData(false)
    val isGenerating: LiveData<Boolean> = _isGenerating

    fun generateWorkOrder(input: WorkOrderInput) {
        if (_isGenerating.value == true) return

        _isGenerating.value = true
        viewModelScope.launch {
            try {
                delay(600)
                val normalizedInput = input.normalized()
                _generatedWorkOrder.value = buildWorkOrder(
                    normalizedInput.copy(
                        sceneDescription = normalizedInput.sceneDescription.ifBlank {
                            buildDefaultSceneDescription(normalizedInput)
                        }
                    )
                )
            } finally {
                _isGenerating.value = false
            }
        }
    }

    private fun buildWorkOrder(input: WorkOrderInput): String {
        val now = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.CHINA).format(Date())
        val orderNo = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.CHINA).format(Date())
        val system = input.system.ifBlank { inferSystem(input.sceneDescription) }
        val priority = input.priority.ifBlank { inferPriority(input.sceneDescription) }
        val actionType = input.actionType.ifBlank { inferActionType(input.templateName) }
        val title = buildTitle(input.templateName, system, input.sceneDescription)
        val assignee = inferAssignee(system, actionType)

        return """
            工单编号：WO-$orderNo
            工单状态：待派发
            工单标题：$title
            工单模板：${input.templateName}
            创建时间：$now

            一、设备信息
            风场/场站：${input.windFarm.ifBlank { "待确认" }}
            风机型号：${input.turbineModel.ifBlank { "待确认" }}
            机位号：${input.turbineNo.ifBlank { inferTurbineNo(input.sceneDescription) }}
            系统/部件：$system
            维护类型：$actionType
            优先级：$priority
            建议处理班组：$assignee

            二、故障/缺陷描述
            ${input.sceneDescription}

            三、智能结构化提取
            现象：${inferSymptom(input.sceneDescription)}
            可能故障模式：${inferFailureMode(input.sceneDescription, system)}
            数据证据：${inferEvidence(input.sceneDescription)}
            影响判断：${inferImpact(priority, actionType)}

            四、处置模板
            ${buildActionChecklist(input.templateName, system)}

            五、安全措施
            1. 作业前完成两票/许可确认，核对风速、天气和远程停机状态。
            2. 涉及电气柜、变桨、偏航、传动链时先执行断电、挂牌和防误动确认。
            3. 登塔或机舱作业需确认个人防护、通信链路和应急撤离条件。

            六、备件与工具
            ${inferResources(system)}

            七、完工回填
            实际原因：__________
            处理措施：__________
            更换备件：__________
            停机时长：__________
            复测结果：报警清除，SCADA/CMS 数据恢复稳定，连续观察 15 分钟无复发。
        """.trimIndent()
    }

    private fun buildTitle(templateName: String, system: String, description: String): String {
        val turbineNo = inferTurbineNo(description)
        val subject = if (turbineNo == "待确认") system else "$turbineNo $system"
        return when (templateName) {
            TEMPLATE_CORRECTIVE -> "$subject 故障抢修"
            TEMPLATE_DEFECT -> "$subject 巡检缺陷处理"
            TEMPLATE_PREVENTIVE -> "$subject 预防检修"
            else -> "$subject 运维处理"
        }
    }

    private fun inferPriority(description: String): String {
        val urgentKeywords = listOf("停机", "冒烟", "起火", "短路", "漏电", "伤人", "无法启动", "全部", "严重", "紧急")
        val highKeywords = listOf("报警", "故障", "异常", "失效", "过温", "过载", "断开", "卡死", "泄漏")

        return when {
            urgentKeywords.any { description.contains(it, ignoreCase = true) } -> "P1 紧急"
            highKeywords.any { description.contains(it, ignoreCase = true) } -> "P2 高"
            else -> "P3 普通"
        }
    }

    private fun inferSystem(description: String): String {
        return when {
            description.contains("变桨", ignoreCase = true) -> "变桨系统"
            description.contains("偏航", ignoreCase = true) -> "偏航系统"
            description.contains("齿轮箱", ignoreCase = true) ||
                description.contains("轴承", ignoreCase = true) ||
                description.contains("振动", ignoreCase = true) -> "传动链/齿轮箱"
            description.contains("发电机", ignoreCase = true) -> "发电机系统"
            description.contains("变流", ignoreCase = true) ||
                description.contains("逆变", ignoreCase = true) -> "变流器系统"
            description.contains("叶片", ignoreCase = true) -> "叶片系统"
            description.contains("通信", ignoreCase = true) ||
                description.contains("网络", ignoreCase = true) -> "通信/SCADA"
            else -> "待确认系统"
        }
    }

    private fun inferTurbineNo(description: String): String {
        val patterns = listOf(
            Regex("([A-Za-z]?\\d{1,3})\\s*号?\\s*风机"),
            Regex("(\\d{1,3})\\s*#"),
            Regex("([A-Za-z]?\\d{1,3})\\s*机位")
        )

        for (pattern in patterns) {
            val match = pattern.find(description)
            if (match != null) return match.groupValues[1]
        }
        return "待确认"
    }

    private fun inferActionType(templateName: String): String {
        return when (templateName) {
            TEMPLATE_CORRECTIVE -> "故障抢修"
            TEMPLATE_DEFECT -> "巡检消缺"
            TEMPLATE_PREVENTIVE -> "预防性维护"
            else -> "现场处理"
        }
    }

    private fun inferAssignee(system: String, actionType: String): String {
        return when {
            system.contains("通信") -> "自动化/通信工程师"
            system.contains("变流") || system.contains("变桨") || system.contains("发电机") -> "电气运维工程师"
            system.contains("齿轮箱") || system.contains("偏航") || system.contains("叶片") -> "机械运维工程师"
            actionType.contains("巡检") -> "巡检消缺班组"
            else -> "风机运维班组"
        }
    }

    private fun inferSymptom(description: String): String {
        val symptomKeywords = listOf("报警", "停机", "异响", "振动", "过温", "断链", "通讯中断", "功率下降", "油温高", "压力低")
        return symptomKeywords.firstOrNull { description.contains(it, ignoreCase = true) }
            ?: "现场描述中未明确，需补充报警码、时间和运行状态。"
    }

    private fun inferFailureMode(description: String, system: String): String {
        return when {
            description.contains("反复", ignoreCase = true) -> "间歇性故障，优先排查接插件、供电波动和通信质量。"
            description.contains("过温", ignoreCase = true) || description.contains("温度", ignoreCase = true) ->
                "温度越限，关注散热、润滑、负载和传感器漂移。"
            description.contains("振动", ignoreCase = true) || description.contains("异响", ignoreCase = true) ->
                "机械振动/异响，关注轴承、齿轮啮合、紧固件和对中状态。"
            system.contains("变桨") -> "变桨角度/驱动/供电链路异常。"
            system.contains("通信") -> "SCADA 通信链路或网关连接异常。"
            else -> "待现场结合报警码、运行曲线和历史工单确认。"
        }
    }

    private fun inferEvidence(description: String): String {
        val evidence = mutableListOf<String>()
        if (description.contains("SCADA", ignoreCase = true) || description.contains("报警", ignoreCase = true)) {
            evidence.add("SCADA 报警/事件记录")
        }
        if (description.contains("振动", ignoreCase = true) || description.contains("CMS", ignoreCase = true)) {
            evidence.add("CMS 振动趋势")
        }
        if (description.contains("温度", ignoreCase = true) || description.contains("过温", ignoreCase = true)) {
            evidence.add("温度趋势")
        }
        if (description.contains("功率", ignoreCase = true)) {
            evidence.add("功率曲线")
        }
        return if (evidence.isEmpty()) "需补充报警码、运行曲线、现场照片或检修记录。" else evidence.joinToString("、")
    }

    private fun inferImpact(priority: String, actionType: String): String {
        return when {
            priority.startsWith("P1") -> "存在停机或安全风险，应立即派工并闭环复测。"
            actionType.contains("预防") -> "当前以风险预防为主，可按计划窗口安排。"
            else -> "存在发电效率或设备可靠性影响，建议当天完成排查。"
        }
    }

    private fun buildActionChecklist(templateName: String, system: String): String {
        val common = when {
            system.contains("变桨") -> "检查 24V/400V 供电、驱动器状态、电池/超级电容、编码器和桨叶角度反馈。"
            system.contains("偏航") -> "检查偏航电机、制动器、偏航齿圈润滑、限位和风向标信号。"
            system.contains("齿轮箱") -> "检查油位油质、滤芯压差、振动频谱、轴承温度和内窥镜条件。"
            system.contains("变流") -> "检查模块温度、直流母线、电容、风扇滤网、接线端子和故障码。"
            system.contains("通信") -> "检查交换机端口、光纤/网线、IP 配置、网关状态和数据上送链路。"
            else -> "检查报警码、设备状态、接线、供电、传感器反馈和历史趋势。"
        }

        return when (templateName) {
            TEMPLATE_CORRECTIVE -> """
                1. 接单后确认是否停机、是否可远程复位、是否需要备件。
                2. 到场复核报警码和安全隔离状态。
                3. $common
                4. 修复后执行复位、并网测试和负荷观察。
            """.trimIndent()
            TEMPLATE_DEFECT -> """
                1. 按巡检发现记录缺陷位置、照片和风险等级。
                2. 判断是否影响运行，必要时升级为抢修工单。
                3. $common
                4. 完成消缺后回填照片、处理人和复查结论。
            """.trimIndent()
            TEMPLATE_PREVENTIVE -> """
                1. 按计划窗口确认停机许可、备件和工具包。
                2. 执行清洁、紧固、润滑、参数备份和功能测试。
                3. $common
                4. 记录维护前后数据，形成趋势对比。
            """.trimIndent()
            else -> "1. 复核现场。2. 排查故障。3. 回填结果。"
        }
    }

    private fun inferResources(system: String): String {
        return when {
            system.contains("变桨") -> "万用表、绝缘工具、驱动器诊断线、编码器/限位备件、24V 电源模块。"
            system.contains("偏航") -> "扭矩工具、润滑脂、偏航制动检查工具、限位开关备件。"
            system.contains("齿轮箱") -> "测温仪、振动检测工具、滤芯、润滑油取样瓶、内窥镜。"
            system.contains("变流") -> "防静电工具、滤网/风扇、功率模块检查工具、绝缘测试工具。"
            system.contains("通信") -> "光功率计、网线测试仪、备用交换机端口、配置备份。"
            else -> "常用检修工具、设备手册、历史报警记录、现场照片和必要备品备件。"
        }
    }

    private fun buildDefaultSceneDescription(input: WorkOrderInput): String {
        val windFarm = input.windFarm.ifBlank { "所选风场" }
        val model = input.turbineModel.ifBlank { "所选机型" }
        val turbineNo = input.turbineNo.ifBlank { "待确认机位" }
        val system = input.system.ifBlank { "待确认系统" }

        return when (input.templateName) {
            TEMPLATE_CORRECTIVE -> "$windFarm $turbineNo $model $system 发生报警或异常停机，需现场确认报警码、停机原因和复位条件。"
            TEMPLATE_DEFECT -> "$windFarm $turbineNo $model 巡检发现 $system 存在缺陷隐患，需安排消缺并回填现场照片和复查结论。"
            TEMPLATE_PREVENTIVE -> "$windFarm $turbineNo $model 计划开展 $system 预防性维护，需按检修窗口执行检查、清洁、紧固和功能复测。"
            else -> "$windFarm $turbineNo $model $system 需安排现场运维处理。"
        }
    }

    private fun WorkOrderInput.normalized(): WorkOrderInput {
        return copy(
            templateName = templateName.ifBlank { TEMPLATE_CORRECTIVE },
            windFarm = windFarm.trim(),
            turbineModel = turbineModel.trim(),
            turbineNo = turbineNo.trim(),
            system = system.trim(),
            priority = priority.trim(),
            actionType = actionType.trim(),
            sceneDescription = sceneDescription.trim()
        )
    }

    companion object {
        const val TEMPLATE_CORRECTIVE = "故障抢修模板"
        const val TEMPLATE_DEFECT = "巡检消缺模板"
        const val TEMPLATE_PREVENTIVE = "预防检修模板"
    }
}

data class WorkOrderInput(
    val templateName: String,
    val windFarm: String,
    val turbineModel: String,
    val turbineNo: String,
    val system: String,
    val priority: String,
    val actionType: String,
    val sceneDescription: String
)
