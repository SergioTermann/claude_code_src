package com.example.hantech.ui.workorder

import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.os.Bundle
import android.net.Uri
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Spinner
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import androidx.lifecycle.ViewModelProvider
import androidx.navigation.fragment.findNavController
import com.example.hantech.R
import com.example.hantech.auth.CoworkerChatStore
import com.example.hantech.auth.CoworkerDirectory
import com.example.hantech.auth.SessionManager
import com.example.hantech.databinding.FragmentWorkOrderBinding
import com.example.hantech.ui.profile.CoworkerChatFragment
import com.example.hantech.ui.reflow.ChatMessage
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class WorkOrderFragment : Fragment() {

    private var _binding: FragmentWorkOrderBinding? = null
    private val binding get() = _binding!!

    private lateinit var viewModel: WorkOrderViewModel
    private var selectedTemplate = WorkOrderViewModel.TEMPLATE_CORRECTIVE
    private var latestWorkOrder: String = ""
    private var currentUser: String = ""
    private var optionalFieldsExpanded = false

    private val createPdfLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/pdf")
    ) { uri ->
        if (uri != null) {
            writeWorkOrderPdf(uri)
        }
    }

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?
    ): View {
        _binding = FragmentWorkOrderBinding.inflate(inflater, container, false)
        viewModel = ViewModelProvider(this)[WorkOrderViewModel::class.java]
        currentUser = SessionManager.currentUser(requireContext()).orEmpty()

        setupTemplates()
        setupWindFarmSelectors()
        setupForwardOptions()
        setupInputArea()
        observeViewModel()
        applyTemplate(WorkOrderViewModel.TEMPLATE_CORRECTIVE)

        return binding.root
    }

    private fun setupTemplates() {
        binding.templateCorrectiveCard.setOnClickListener {
            applyTemplate(WorkOrderViewModel.TEMPLATE_CORRECTIVE)
        }
        binding.templateDefectCard.setOnClickListener {
            applyTemplate(WorkOrderViewModel.TEMPLATE_DEFECT)
        }
        binding.templatePreventiveCard.setOnClickListener {
            applyTemplate(WorkOrderViewModel.TEMPLATE_PREVENTIVE)
        }
    }

    private fun setupWindFarmSelectors() {
        val stationAdapter = ArrayAdapter(
            requireContext(),
            android.R.layout.simple_spinner_item,
            windFarmOptions.map { it.name }
        ).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }

        binding.windFarmSpinner.adapter = stationAdapter
        binding.windFarmSpinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                updateModelOptions(position)
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
        updateModelOptions(0)
    }

    private fun updateModelOptions(stationPosition: Int) {
        val models = windFarmOptions.getOrNull(stationPosition)?.models ?: emptyList()
        val modelAdapter = ArrayAdapter(
            requireContext(),
            android.R.layout.simple_spinner_item,
            models
        ).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
        binding.turbineModelSpinner.adapter = modelAdapter
    }

    private fun setupForwardOptions() {
        val coworkerAdapter = ArrayAdapter(
            requireContext(),
            android.R.layout.simple_spinner_item,
            CoworkerDirectory.items.map { "${it.name} · ${it.role}" }
        ).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
        binding.forwardCoworkerSpinner.adapter = coworkerAdapter
    }

    private fun setupInputArea() {
        binding.generateButton.setOnClickListener {
            generateWorkOrder()
        }

        binding.quickStopFaultButton.setOnClickListener {
            applyQuickScene(
                templateName = WorkOrderViewModel.TEMPLATE_CORRECTIVE,
                scene = "现场反馈风机出现停机报警，SCADA 有故障记录，需确认报警码、复位条件和是否需要立即抢修。",
                system = "待确认系统",
                priority = "P1 紧急",
                actionType = "故障抢修"
            )
        }

        binding.quickPitchPowerButton.setOnClickListener {
            applyQuickScene(
                templateName = WorkOrderViewModel.TEMPLATE_CORRECTIVE,
                scene = "风机变桨系统报 24V 电源故障，现场需检查电源模块、驱动器状态、接线端子和复位条件。",
                system = "变桨系统",
                priority = "P1 紧急",
                actionType = "故障抢修"
            )
        }

        binding.quickInspectionButton.setOnClickListener {
            applyQuickScene(
                templateName = WorkOrderViewModel.TEMPLATE_DEFECT,
                scene = "巡检发现设备存在缺陷隐患，暂未确认停机影响，需现场复核位置、照片、风险等级并安排消缺。",
                system = "待确认系统",
                priority = "P3 普通",
                actionType = "巡检消缺"
            )
        }

        binding.quickPreventiveButton.setOnClickListener {
            applyQuickScene(
                templateName = WorkOrderViewModel.TEMPLATE_PREVENTIVE,
                scene = "计划检修窗口内执行预防性维护，需完成清洁、紧固、润滑、功能复测和维护前后数据记录。",
                system = "待确认系统",
                priority = "P4 计划",
                actionType = "预防性维护"
            )
        }

        binding.optionalFieldsToggleButton.setOnClickListener {
            optionalFieldsExpanded = !optionalFieldsExpanded
            binding.basicInfoPanel.visibility = if (optionalFieldsExpanded) View.VISIBLE else View.GONE
            binding.optionalFieldsToggleButton.text = if (optionalFieldsExpanded) "收起补充字段" else "展开补充字段"
        }

        binding.downloadPdfButton.setOnClickListener {
            downloadPdf()
        }

        binding.forwardWorkOrderButton.setOnClickListener {
            forwardWorkOrder()
        }

        binding.sceneInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                generateWorkOrder()
                true
            } else {
                false
            }
        }

    }

    private fun applyQuickScene(
        templateName: String,
        scene: String,
        system: String,
        priority: String,
        actionType: String
    ) {
        applyTemplate(templateName)
        selectSpinnerValue(binding.systemSpinner, system)
        selectSpinnerValue(binding.prioritySpinner, priority)
        selectSpinnerValue(binding.actionTypeSpinner, actionType)
        binding.sceneInput.setText(scene)
        binding.sceneInput.setSelection(scene.length)
    }

    private fun selectSpinnerValue(spinner: Spinner, value: String) {
        val adapter = spinner.adapter ?: return
        for (index in 0 until adapter.count) {
            if (adapter.getItem(index)?.toString() == value) {
                spinner.setSelection(index)
                return
            }
        }
    }

    private fun observeViewModel() {
        viewModel.generatedWorkOrder.observe(viewLifecycleOwner) { workOrder ->
            latestWorkOrder = workOrder
            binding.resultContainer.visibility = View.VISIBLE
            binding.resultText.text = workOrder
            binding.contentScroll.post {
                binding.contentScroll.smoothScrollTo(0, binding.resultContainer.bottom)
            }
        }

        viewModel.isGenerating.observe(viewLifecycleOwner) { isGenerating ->
            binding.sceneInput.isEnabled = !isGenerating
            binding.generateButton.isEnabled = !isGenerating
            binding.generateButton.text = if (isGenerating) "生成中..." else "一键生成工单"
        }
    }

    private fun applyTemplate(templateName: String) {
        selectedTemplate = templateName
        updateTemplateSelection(templateName)

        when (templateName) {
            WorkOrderViewModel.TEMPLATE_CORRECTIVE -> {
                binding.prioritySpinner.setSelection(0)
                binding.actionTypeSpinner.setSelection(0)
                binding.sceneInput.hint = "例：3号风机变桨系统报 24V 电源故障，SCADA 显示停机，现场需抢修"
            }
            WorkOrderViewModel.TEMPLATE_DEFECT -> {
                binding.prioritySpinner.setSelection(2)
                binding.actionTypeSpinner.setSelection(1)
                binding.sceneInput.hint = "例：巡检发现 8号风机塔筒控制柜端子松动，暂未停机，需要消缺"
            }
            WorkOrderViewModel.TEMPLATE_PREVENTIVE -> {
                binding.prioritySpinner.setSelection(3)
                binding.actionTypeSpinner.setSelection(2)
                binding.sceneInput.hint = "例：计划对 12号风机齿轮箱滤芯更换并检查油温趋势"
            }
        }
    }

    private fun updateTemplateSelection(templateName: String) {
        val correctiveSelected = templateName == WorkOrderViewModel.TEMPLATE_CORRECTIVE
        val defectSelected = templateName == WorkOrderViewModel.TEMPLATE_DEFECT
        val preventiveSelected = templateName == WorkOrderViewModel.TEMPLATE_PREVENTIVE

        binding.templateCorrectiveCard.strokeColor = templateStrokeColor(correctiveSelected)
        binding.templateCorrectiveCard.strokeWidth = templateStrokeWidth(correctiveSelected)
        binding.templateDefectCard.strokeColor = templateStrokeColor(defectSelected)
        binding.templateDefectCard.strokeWidth = templateStrokeWidth(defectSelected)
        binding.templatePreventiveCard.strokeColor = templateStrokeColor(preventiveSelected)
        binding.templatePreventiveCard.strokeWidth = templateStrokeWidth(preventiveSelected)
    }

    private fun templateStrokeColor(isSelected: Boolean): Int {
        val colorRes = if (isSelected) R.color.ops_accent else R.color.ops_line
        return requireContext().getColor(colorRes)
    }

    private fun templateStrokeWidth(isSelected: Boolean): Int {
        return resources.getDimensionPixelSize(if (isSelected) R.dimen.work_order_selected_stroke else R.dimen.work_order_normal_stroke)
    }

    private fun generateWorkOrder() {
        val input = WorkOrderInput(
            templateName = selectedTemplate,
            windFarm = normalizeOptionalSelection(binding.windFarmSpinner.selectedItem?.toString().orEmpty()),
            turbineModel = normalizeOptionalSelection(binding.turbineModelSpinner.selectedItem?.toString().orEmpty()),
            turbineNo = binding.turbineInput.text?.toString().orEmpty(),
            system = normalizeOptionalSelection(binding.systemSpinner.selectedItem?.toString().orEmpty()),
            priority = binding.prioritySpinner.selectedItem?.toString().orEmpty(),
            actionType = binding.actionTypeSpinner.selectedItem?.toString().orEmpty(),
            sceneDescription = binding.sceneInput.text?.toString().orEmpty()
        )
        viewModel.generateWorkOrder(input)
    }

    private fun normalizeOptionalSelection(value: String): String {
        return if (value.startsWith("待确认")) "" else value
    }

    private fun downloadPdf() {
        if (latestWorkOrder.isBlank()) {
            Toast.makeText(requireContext(), "请先生成工单", Toast.LENGTH_SHORT).show()
            return
        }

        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.CHINA).format(Date())
        createPdfLauncher.launch("风电运维工单_$timestamp.pdf")
    }

    private fun forwardWorkOrder() {
        if (latestWorkOrder.isBlank()) {
            Toast.makeText(requireContext(), "请先生成工单", Toast.LENGTH_SHORT).show()
            return
        }
        if (currentUser.isBlank()) {
            Toast.makeText(requireContext(), "当前账号异常，请重新登录", Toast.LENGTH_SHORT).show()
            return
        }

        val coworker = CoworkerDirectory.items.getOrNull(binding.forwardCoworkerSpinner.selectedItemPosition)
            ?: CoworkerDirectory.items.first()
        try {
            val pdfFile = createForwardPdfFile(coworker.id)
            val message = ChatMessage(
                content = "转发工单 PDF",
                isUser = true,
                attachmentName = pdfFile.name,
                attachmentPath = pdfFile.absolutePath
            )
            CoworkerChatStore.append(requireContext(), currentUser, coworker.id, message)
            Toast.makeText(requireContext(), "已转发 PDF 给${coworker.name}", Toast.LENGTH_SHORT).show()
            findNavController().navigate(
                R.id.nav_coworker_chat,
                bundleOf(CoworkerChatFragment.ARG_COWORKER_ID to coworker.id)
            )
        } catch (exception: IOException) {
            Toast.makeText(requireContext(), "PDF 转发失败：${exception.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun createForwardPdfFile(coworkerId: String): File {
        val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.CHINA).format(Date())
        val directory = File(requireContext().filesDir, "forwarded_work_orders/$currentUser/$coworkerId")
        if (!directory.exists()) {
            directory.mkdirs()
        }
        val file = File(directory, "风电运维工单_$timestamp.pdf")
        FileOutputStream(file).use { outputStream ->
            val document = createPdfDocument(latestWorkOrder)
            try {
                document.writeTo(outputStream)
            } finally {
                document.close()
            }
        }
        return file
    }

    private fun writeWorkOrderPdf(uri: Uri) {
        try {
            requireContext().contentResolver.openOutputStream(uri)?.use { outputStream ->
                val document = createPdfDocument(latestWorkOrder)
                try {
                    document.writeTo(outputStream)
                } finally {
                    document.close()
                }
            } ?: throw IOException("无法打开文件输出流")

            Toast.makeText(requireContext(), "PDF 已保存", Toast.LENGTH_SHORT).show()
        } catch (exception: IOException) {
            Toast.makeText(requireContext(), "PDF 保存失败：${exception.message}", Toast.LENGTH_LONG).show()
        }
    }

    private fun createPdfDocument(content: String): PdfDocument {
        val document = PdfDocument()
        val pageWidth = 595
        val pageHeight = 842
        val margin = 42f
        val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = requireContext().getColor(R.color.green_900)
            textSize = 20f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        val bodyPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = requireContext().getColor(R.color.ops_ink)
            textSize = 11.5f
            typeface = Typeface.create(Typeface.SANS_SERIF, Typeface.NORMAL)
        }
        val metaPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = requireContext().getColor(R.color.ops_muted)
            textSize = 9.5f
        }

        var pageNumber = 1
        var page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
        var canvas = page.canvas
        var y = margin

        fun drawPageHeader() {
            canvas.drawText("风电运维工单", margin, y, titlePaint)
            y += 18f
            canvas.drawText("由风电智能运维平台生成", margin, y, metaPaint)
            y += 24f
        }

        fun newPage() {
            document.finishPage(page)
            pageNumber += 1
            page = document.startPage(PdfDocument.PageInfo.Builder(pageWidth, pageHeight, pageNumber).create())
            canvas = page.canvas
            y = margin
            drawPageHeader()
        }

        drawPageHeader()

        content.lines().flatMap { wrapPdfLine(it, bodyPaint, pageWidth - margin * 2) }.forEach { line ->
            if (y > pageHeight - margin) {
                newPage()
            }
            canvas.drawText(line, margin, y, bodyPaint)
            y += 17f
        }

        document.finishPage(page)
        return document
    }

    private fun wrapPdfLine(line: String, paint: Paint, maxWidth: Float): List<String> {
        if (line.isBlank()) return listOf("")

        val wrappedLines = mutableListOf<String>()
        var currentLine = ""
        line.forEach { char ->
            val candidate = currentLine + char
            if (paint.measureText(candidate) <= maxWidth) {
                currentLine = candidate
            } else {
                wrappedLines.add(currentLine)
                currentLine = char.toString()
            }
        }
        if (currentLine.isNotEmpty()) {
            wrappedLines.add(currentLine)
        }
        return wrappedLines
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _binding = null
    }

    private data class WindFarmOption(
        val name: String,
        val models: List<String>
    )

    private companion object {
        val windFarmOptions = listOf(
            WindFarmOption("待确认场站", listOf("待确认机型")),
            WindFarmOption("新华风电场", listOf("三一 SE8715", "华仪 HW2/S1500(87)", "运达 WD88-1500A")),
            WindFarmOption("(一期)通榆团结风电场", listOf("华仪 HW2/S2000(103)")),
            WindFarmOption("（二期）/（三期）通榆团结风电场", listOf("三一 SE11520")),
            WindFarmOption("（四期）吉林通榆团结D风电场", listOf("运达 WD140-2500")),
            WindFarmOption("（四期）/（五期）吉林通榆团结D风电场", listOf("运达 WD147-3000")),
            WindFarmOption("中溢B期风电场", listOf("三一 SI-200625")),
            WindFarmOption("华能四平风电场一期风电场", listOf("金风 GW82-1500")),
            WindFarmOption("华能四平风电场二期风电场", listOf("新誉 FD77-1500-III")),
            WindFarmOption("华能四平风电场二期/四期风电场", listOf("华仪 HW82/1500")),
            WindFarmOption("华能四平风电场一期/四期风电场", listOf("三一 SE8215-L3")),
            WindFarmOption("华能四平风电场三期风电场", listOf("上海电气 W2000C-93-80", "湘电 XE82-2000")),
            WindFarmOption("华能四平风电场五期风电场", listOf("远景 EN156/3.0", "远景 EN141-2500")),
            WindFarmOption("同发风电场", listOf("华锐 SL1500/77", "华锐 SL1500/77/XR", "华锐 SL1500/77(bachmann)")),
            WindFarmOption("洮北风电场", listOf("歌美飒 G58-850", "上海电气 SEC-1250", "明阳 MY1.5se-82", "明阳 MY1.5Se-89/70")),
            WindFarmOption("良井子风电场", listOf("明阳 MySE3.2-156", "明阳 MySE4.0-156")),
            WindFarmOption("什花道风电场", listOf("远景 EN-156/5.0", "远景 EN-156/3.3", "三一 SE16033")),
            WindFarmOption("向荣风电场", listOf("中车山东 CWT4200-D175", "中车山东 CWT4800-D185")),
            WindFarmOption("裕民风电场", listOf("海装 HN2700-77&62", "三一 SI-193625", "三一 SE16033", "运达 WD200-6250-H115")),
            WindFarmOption("镇赉风电场", listOf("华锐 SL1500/77", "金风 GW82/1500", "华锐 SL1500/82(ver1.0)")),
            WindFarmOption("八面风电场", listOf("中车山东 CWT4800-D185", "中车山东 CWT4200-D175")),
            WindFarmOption("前进风电场", listOf("三一 SI-200625")),
            WindFarmOption("富荣风电场", listOf("上海电气 EW6.25N-202")),
            WindFarmOption("福林风电场", listOf("运达 WD200-5500-H115", "运达 WD200-6250-H115")),
            WindFarmOption("长龙山/裕民风电场", listOf("运达 WD200-6250-H115")),
            WindFarmOption("如意风电场", listOf("上海电气 EW6.25N-202")),
            WindFarmOption("得胜风电场", listOf("三一 SI-200625", "三一 SI-20067"))
        )
    }
}
