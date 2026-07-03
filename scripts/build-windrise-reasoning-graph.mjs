#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FAULT_MECHANISM_GRAPH = join(ROOT, 'wind-llmwiki', 'graph', 'fault-mechanism', 'knowledge-graph.json')
const PDF_QA_CACHE = join(ROOT, 'generated-knowledge', 'pdf-question-answer-cache.json')
const WIND_QUESTIONS = join(ROOT, 'generated-knowledge', 'wind-operation-maintenance-questions.md')
const OUT_FILE = join(ROOT, 'generated-knowledge', 'windrise-reasoning-graph.json')

const IMPORTANT_MECHANISM_IDS = [
  'mechanism:pitch-24v-feedback-loss',
  'mechanism:pitch-hydraulic-pressure-loss',
  'mechanism:pitch-actuator-position-error',
  'mechanism:converter-dc-link-grid-disturbance',
  'mechanism:converter-control-communication-loss',
  'mechanism:generator-bearing-thermal-lubrication',
  'mechanism:gearbox-bearing-gear-wear',
  'mechanism:yaw-drive-brake-limit',
  'mechanism:thermal-management-sensor-chain',
  'mechanism:plc-io-feedback-chain',
  'mechanism:rotor-blade-imbalance-damage',
  'mechanism:safety-chain-emergency-stop',
  'mechanism:main-shaft-bearing-lubrication-load',
  'mechanism:mechanical-brake-pressure-friction',
  'mechanism:hydraulic-station-pump-accumulator-valve',
  'mechanism:cooling-water-loop-flow-temperature',
  'mechanism:lubrication-system-flow-grease-oil',
  'mechanism:communication-network-loss',
  'mechanism:grid-transformer-protection',
  'mechanism:sensor-measurement-chain-drift-fault',
  'mechanism:yaw-cable-twist-position-limit',
  'mechanism:nacelle-tower-vibration-structural-load',
  'mechanism:environment-lightning-grounding-surge',
  'mechanism:scada-data-quality-alarm-correlation',
]

const SYSTEM_DOMAINS = [
  {
    id: 'domain:yaw_system',
    label: '偏航系统',
    keywords: ['偏航', 'yaw', '偏航电机', '偏航减速机', '偏航制动', '偏航编码器', '偏航限位', '扭缆', '解缆', '偏航过慢', '偏航位置'],
    subsystems: [
      {
        id: 'subdomain:yaw_drive_position',
        label: '偏航驱动与位置反馈',
        keywords: ['偏航过慢', '偏航电机', '偏航减速机', '偏航编码器', '编码器反馈', '偏航位置', '192', '193', '194'],
        caseIds: ['case:llmwiki_yaw-drive-brake-limit', 'case:yaw_speed_encoder_feedback'],
        signals: ['偏航速度/位置反馈', '左右偏航角度连续性', '编码器脉冲和方向'],
        firstActions: ['核对偏航方向、角度变化和编码器反馈是否一致', '检查偏航电机、减速机、编码器接线和限位状态'],
      },
      {
        id: 'subdomain:yaw_brake_pressure',
        label: '偏航制动与液压释放',
        keywords: ['偏航制动', '偏航刹车', '制动压力', '偏航液压', '阻尼缓冲器', '压力恢复', 't_228', 't_229'],
        caseIds: ['case:yaw_hydraulic_pressure', 'case:yaw_brake_pressure_sensor', 'case:llmwiki_yaw-drive-brake-limit'],
        signals: ['偏航制动压力', '建压/泄压时间', '压力传感器反馈'],
        firstActions: ['先用机械压力表对比HMI压力', '复核换向阀、节流/阻尼元件和压力开关反馈'],
      },
      {
        id: 'subdomain:yaw_cable_limit',
        label: '偏航扭缆与限位保护',
        keywords: ['扭缆', '解缆', '偏航限位', '左右限位', '扭缆开关', '偏航角度'],
        caseIds: ['case:llmwiki_yaw-cable-twist-position-limit'],
        signals: ['扭缆圈数', '左右限位状态', '偏航角度零点'],
        firstActions: ['确认扭缆圈数和偏航角度是否越界', '检查限位开关和解缆逻辑反馈'],
      },
    ],
    caseIds: [
      'case:llmwiki_yaw-drive-brake-limit',
      'case:llmwiki_yaw-cable-twist-position-limit',
      'case:yaw_hydraulic_pressure',
      'case:yaw_brake_pressure_sensor',
      'case:yaw_speed_encoder_feedback',
    ],
  },
  {
    id: 'domain:hydraulic_brake_system',
    label: '液压与制动系统',
    keywords: ['液压', '液压站', '液压泵', '蓄能器', '电磁阀', '阀组', '制动', '刹车', '刹车泵', '压力开关', '建压', '保压', '油压', '滤芯'],
    subsystems: [
      {
        id: 'subdomain:hydraulic_pump_accumulator',
        label: '液压泵源与蓄能器',
        keywords: ['液压泵', '液压站', '蓄能器', '蓄能器预充', '预充不足', '建压慢', '频繁补压', '保压失败', 'yx277', 'yx278', 'yx279', '5806', 'q16.1'],
        caseIds: ['case:llmwiki_hydraulic-station-pump-accumulator-valve', 'case:hydraulic_pump_runtime', 'case:hydraulic_pump_breaker_trip'],
        signals: ['泵启动次数', '泵电流', '出口压力', '蓄能器预充压力'],
        firstActions: ['先记录泵启动次数、建压时间和出口压力', '测蓄能器预充压力并检查泵电流/断路器'],
      },
      {
        id: 'subdomain:brake_pressure_feedback',
        label: '制动压力与刹车反馈',
        keywords: ['刹车泵', '刹车压力', '制动压力', '压力开关', '无压力', 'a240.1', '代码65', '故障代码65'],
        caseIds: ['case:llmwiki_mechanical-brake-pressure-friction', 'case:brake_pump_no_pressure', 'case:yaw_brake_pressure_sensor'],
        signals: ['制动压力开关', '刹车释放反馈', '摩擦片状态'],
        firstActions: ['机械表确认真实制动压力', '检查压力开关、刹车泵反馈和摩擦片释放状态'],
      },
      {
        id: 'subdomain:hydraulic_valve_filter',
        label: '阀组、油液与滤芯',
        keywords: ['电磁阀', '换向阀', '阀组', '滤芯', '油温', '油位', '油液污染', '压差'],
        caseIds: ['case:llmwiki_hydraulic-station-pump-accumulator-valve', 'case:yaw_hydraulic_pressure'],
        signals: ['滤芯压差', '阀动作反馈', '油位油温', '油液污染'],
        firstActions: ['查看滤芯压差、油位油温和油液污染', '调换或点动阀组确认故障是否随阀转移'],
      },
    ],
    caseIds: [
      'case:llmwiki_hydraulic-station-pump-accumulator-valve',
      'case:llmwiki_mechanical-brake-pressure-friction',
      'case:yaw_hydraulic_pressure',
      'case:yaw_brake_pressure_sensor',
      'case:hydraulic_pump_runtime',
      'case:hydraulic_pump_breaker_trip',
      'case:brake_pump_no_pressure',
    ],
  },
  {
    id: 'domain:pitch_system',
    label: '变桨系统',
    keywords: ['变桨', '桨距', '桨叶', '叶片', '轮毂', '变桨轴', '变桨驱动', '变桨变频器', '24v', '桨距角', '限位开关', '顺桨'],
    subsystems: [
      {
        id: 'subdomain:pitch_24v_feedback',
        label: '变桨24V电源与反馈',
        keywords: ['24v', '24V主电源', '反馈丢失', '开关反馈', '303804', '303809', '303810', '303811'],
        caseIds: ['case:llmwiki_pitch-24v-feedback-loss'],
        signals: ['24V开关反馈', 'PLC DI状态', '轴柜电源状态'],
        firstActions: ['先量24V电源和反馈触点', '核对PLC输入点与轴柜开关状态'],
      },
      {
        id: 'subdomain:pitch_actuator_position',
        label: '变桨驱动与桨距位置',
        keywords: ['桨距', '桨距角', '位置反馈', '编码器', '限位开关', '不同步', '卡滞', '顺桨失败'],
        caseIds: ['case:llmwiki_pitch-actuator-position-error'],
        signals: ['桨距角偏差', '编码器反馈', '限位开关', '驱动器状态'],
        firstActions: ['比较三支桨距角和编码器反馈', '检查驱动器、限位开关和机械卡滞'],
      },
      {
        id: 'subdomain:pitch_hydraulic_energy',
        label: '变桨液压与蓄能能力',
        anchors: ['变桨', '桨距', '桨叶', '轮毂', '液压变桨'],
        keywords: ['变桨液压', '蓄能器', '液压变桨', '压力不足', '蓄能能力', '泄压'],
        caseIds: ['case:llmwiki_pitch-hydraulic-pressure-loss'],
        signals: ['变桨压力', '蓄能器压力', '泄压速度'],
        firstActions: ['测变桨液压压力和蓄能器预充', '检查阀组泄漏和应急顺桨能力'],
      },
    ],
    caseIds: [
      'case:llmwiki_pitch-24v-feedback-loss',
      'case:llmwiki_pitch-hydraulic-pressure-loss',
      'case:llmwiki_pitch-actuator-position-error',
      'case:llmwiki_rotor-blade-imbalance-damage',
    ],
  },
  {
    id: 'domain:generator_drivetrain',
    label: '发电机与传动链',
    keywords: ['发电机', '绕组', '定子', '转子', '发电机轴承', '齿轮箱', '传动链', '主轴', '高速轴', '低速轴', '轴承', '齿轮', '齿轮油', '油温', '振动', '润滑'],
    subsystems: [
      {
        id: 'subdomain:gearbox_oil_filter',
        label: '齿轮箱油温、滤芯与润滑',
        keywords: ['齿轮箱油温', '齿轮箱滤芯', '齿轮箱过滤器', '滤芯压差', '齿轮油', '润滑泵', '油位', '油样', '80012', '80051', '80052'],
        caseIds: ['case:llmwiki_lubrication-system-flow-grease-oil', 'case:llmwiki_gearbox-bearing-gear-wear'],
        signals: ['齿轮箱油温', '滤芯压差', '油位', '油样污染', '冷却运行状态'],
        firstActions: ['先确认冷却风扇/水冷运行、油位和滤芯压差', '必要时更换滤芯并取油样看污染/金属屑'],
      },
      {
        id: 'subdomain:gearbox_bearing_vibration',
        label: '齿轮箱轴承、齿轮副与振动',
        keywords: ['齿轮箱轴承', '齿轮副', '高速轴', '低速轴', '振动', '异响', '磨损', '温升'],
        caseIds: ['case:llmwiki_gearbox-bearing-gear-wear'],
        signals: ['振动频谱', '轴承温度', '齿轮啮合频率', '异响'],
        firstActions: ['对比振动频谱、油温和负载关系', '检查油样铁谱和内窥镜可见磨损'],
      },
      {
        id: 'subdomain:generator_bearing_winding',
        label: '发电机轴承、绕组与冷却',
        keywords: ['发电机轴承', '绕组', '定子', '转子', '绕组温度', '轴承温度', '冷却风扇', '对中'],
        caseIds: ['case:llmwiki_generator-bearing-thermal-lubrication', 'case:generator_winding_temp_jump'],
        signals: ['绕组温度', '发电机轴承温度', '冷却风量', '振动/对中'],
        firstActions: ['区分绕组温度、轴承温度和测温通道异常', '检查冷却、润滑和对中状态'],
      },
      {
        id: 'subdomain:main_shaft_bearing',
        label: '主轴轴承润滑、密封与载荷',
        keywords: ['主轴', '主轴轴承', '润滑脂', '密封', '进水', '载荷', '低频振动'],
        caseIds: ['case:llmwiki_main-shaft-bearing-lubrication-load', 'case:main_shaft_bearing_wear'],
        signals: ['主轴温度', '润滑脂颜色', '密封状态', '低频振动'],
        firstActions: ['检查润滑脂颜色、水分和金属颗粒', '复核密封、载荷工况和振动趋势'],
      },
    ],
    caseIds: [
      'case:llmwiki_generator-bearing-thermal-lubrication',
      'case:llmwiki_gearbox-bearing-gear-wear',
      'case:llmwiki_main-shaft-bearing-lubrication-load',
      'case:llmwiki_lubrication-system-flow-grease-oil',
      'case:main_shaft_bearing_wear',
      'case:generator_winding_temp_jump',
    ],
  },
  {
    id: 'domain:converter_electrical',
    label: '变流器与电气系统',
    keywords: ['变流器', '变流', '变频', 'igbt', '直流母线', '网侧', '机侧', '并网', '电网', '箱变', '断路器', '接触器', '电压', '电流', '防雷', '浪涌', '接地'],
    subsystems: [
      {
        id: 'subdomain:converter_power_module',
        label: '变流器功率模块与直流母线',
        keywords: ['igbt', '功率模块', '直流母线', '母线电压', '网侧', '机侧', '变流器过流', '变流器过压'],
        caseIds: ['case:llmwiki_converter-dc-link-grid-disturbance', 'case:converter_igbt'],
        signals: ['直流母线电压', 'IGBT温度/驱动状态', '网侧/机侧电流'],
        firstActions: ['先查母线电压、IGBT温度和驱动板告警', '对比网侧/机侧电流与并网状态'],
      },
      {
        id: 'subdomain:converter_control_comm',
        label: '变流器控制板与通信',
        keywords: ['dsp', '控制板', '变流器通信', 'can', '光纤', '通讯中断', '板卡'],
        caseIds: ['case:llmwiki_converter-control-communication-loss', 'case:llmwiki_communication-network-loss'],
        signals: ['控制板状态', 'CAN/光纤链路', '心跳报文'],
        firstActions: ['检查控制板电源、心跳和通信链路', '复核光纤/CAN接插件和终端电阻'],
      },
      {
        id: 'subdomain:grid_transformer_protection',
        label: '电网、箱变与保护',
        keywords: ['电网', '箱变', '并网', '接触器', '断路器', '电能质量', '低电压', '过电压', '频率'],
        caseIds: ['case:llmwiki_grid-transformer-protection', 'case:llmwiki_converter-dc-link-grid-disturbance'],
        signals: ['三相电压电流', '并网接触器状态', '箱变保护', '电能质量'],
        firstActions: ['先看并网点三相电压、电流和保护动作记录', '检查箱变、接触器和断路器状态'],
      },
      {
        id: 'subdomain:electrical_grounding_surge',
        label: '接地、防雷与浪涌',
        keywords: ['防雷', '浪涌', '接地', '屏蔽', '雷击', 'spd', '绝缘'],
        caseIds: ['case:llmwiki_environment-lightning-grounding-surge'],
        signals: ['接地电阻', 'SPD状态', '绝缘电阻', '屏蔽层连接'],
        firstActions: ['检查SPD窗口、接地电阻和屏蔽层连续性', '排查雷击后板卡和通信链路损伤'],
      },
    ],
    caseIds: [
      'case:llmwiki_converter-dc-link-grid-disturbance',
      'case:llmwiki_converter-control-communication-loss',
      'case:llmwiki_grid-transformer-protection',
      'case:llmwiki_environment-lightning-grounding-surge',
      'case:converter_igbt',
    ],
  },
  {
    id: 'domain:control_comm_sensor',
    label: '主控、通信与传感器',
    keywords: ['主控', 'plc', 'io', 'di', 'do', 'ai', '通信', '通讯', 'can', 'profibus', 'ethercat', '光纤', '交换机', 'scada', 'hmi', '传感器', '编码器', '反馈', '测量', '漂移', '断线'],
    subsystems: [
      {
        id: 'subdomain:plc_io_feedback',
        label: 'PLC I/O与辅助触点反馈',
        keywords: ['plc', 'io', 'di', 'do', 'ai', '辅助触点', '无反馈', '反馈丢失', '端子', '接插件'],
        caseIds: ['case:llmwiki_plc-io-feedback-chain'],
        signals: ['PLC输入输出状态', '辅助触点', '端子电压', '接插件状态'],
        firstActions: ['先量端子电压并核对PLC输入点', '检查辅助触点、接插件和线缆通断'],
      },
      {
        id: 'subdomain:comm_network_bus',
        label: '现场总线、光纤与交换网络',
        keywords: ['通信', '通讯', 'can', 'profibus', 'ethercat', '光纤', '交换机', '掉线', '心跳', '超时'],
        caseIds: ['case:llmwiki_communication-network-loss', 'case:llmwiki_converter-control-communication-loss'],
        signals: ['总线状态', '心跳报文', '丢包/超时', '交换机端口'],
        firstActions: ['检查通信供电、端口灯和心跳报文', '复核终端电阻、光纤衰减和接插件'],
      },
      {
        id: 'subdomain:sensor_measurement_chain',
        label: '传感器测量链与漂移断线',
        keywords: ['传感器', '测量', '漂移', '断线', '短路', '温度传感器', '压力传感器', '转速传感器', '振动传感器', '风速风向'],
        caseIds: ['case:llmwiki_sensor-measurement-chain-drift-fault', 'case:llmwiki_thermal-management-sensor-chain'],
        signals: ['传感器原始值', '4-20mA/电阻信号', '采集模块', '屏蔽接地'],
        firstActions: ['对比现场实测值、模块原始值和HMI显示', '检查供电、屏蔽、接地和传感器线缆'],
      },
      {
        id: 'subdomain:scada_alarm_logic',
        label: 'SCADA数据质量与报警逻辑',
        keywords: ['scada', 'hmi', '报警关联', '数据质量', '状态量', '误报', '工况边界', '趋势'],
        caseIds: ['case:llmwiki_scada-data-quality-alarm-correlation'],
        signals: ['SCADA趋势', '状态量时序', '报警触发条件', '工况边界'],
        firstActions: ['拉取报警前后趋势和状态量时序', '确认是否为工况边界、采集质量或逻辑条件问题'],
      },
    ],
    caseIds: [
      'case:llmwiki_plc-io-feedback-chain',
      'case:llmwiki_communication-network-loss',
      'case:llmwiki_sensor-measurement-chain-drift-fault',
      'case:llmwiki_scada-data-quality-alarm-correlation',
      'case:llmwiki_thermal-management-sensor-chain',
    ],
  },
]

const WEAK_ALIAS_TERMS = new Set([
  '报警',
  '告警',
  '停机',
  '复位',
  '故障',
  '故障码',
  '检查',
  '处理',
  '系统',
  '设备',
  '风机',
  '风电',
  '压力',
  '温度',
  '电流',
  '电压',
  '反馈',
  '通信',
  '通讯',
  '传感器',
  '编码器',
  '液压',
  '制动',
  '轴承',
  '润滑',
  '滤芯',
  '阀组',
  '电机',
  '位置',
  '异常',
  '过高',
  '过低',
  '超限',
])

const RELATION_WEIGHTS = {
  CAN_TRIGGER: 52,
  MANIFESTS_AS: 48,
  DIAGNOSED_BY: 46,
  HAS_DIAGNOSTIC_STEP: 34,
  MITIGATED_BY: 30,
  INVOLVES_COMPONENT: 28,
  PRINCIPLE: 18,
}

const CURATED_CASES = [
  { id: 'case:yaw_hydraulic_pressure', label: '偏航液压系统压力异常', aliases: ['阻尼缓冲器', '压力恢复缓慢', '偏航液压系统压力异常'] },
  { id: 'case:yaw_brake_pressure_sensor', label: 'T_228/T_229 偏航制动压力低/传感器故障', aliases: ['t_228', 't_229', '偏航制动压力', '压力传感器'] },
  { id: 'case:hydraulic_pump_runtime', label: 'YX277/YX278/YX279 液压泵动作时间异常', aliases: ['yx277', 'yx278', 'yx279', '液压泵动作', '蓄能器'] },
  { id: 'case:hydraulic_pump_breaker_trip', label: '5806 液压泵断路器跳闸', aliases: ['5806', 'q16.1', '断路器跳闸', '液压泵断路器'] },
  { id: 'case:brake_pump_no_pressure', label: '65 刹车泵无压力/A240.1无反馈', aliases: ['代码65', '故障代码65', 'a240.1', '刹车泵无压力'] },
  { id: 'case:yaw_speed_encoder_feedback', label: '192/193/194 偏航速度/位置反馈异常', aliases: ['192', '193', '194', '偏航驱动速度慢', '偏航传感器', '编码器'] },
  { id: 'case:converter_igbt', label: '变流器IGBT板卡故障', aliases: ['igbt', '变流器igbt', '变流器板卡'] },
  { id: 'case:main_shaft_bearing_wear', label: '主轴轴承复合磨损故障', aliases: ['主轴轴承', '主轴轴承磨损', '复合磨损'] },
  { id: 'case:generator_winding_temp_jump', label: '发电机绕组端温度高/跳变', aliases: ['发电机绕组', '绕组温度跳变', '温度跳变'] },
]

const MECHANISM_ARCHETYPES = [
  {
    id: 'hydraulic_flow_restriction',
    label: '液压能量建立与流阻机理',
    anchors: ['液压', '压力', '建压', '蓄能器', '阀', '泵', '制动', '刹车', '流量'],
    keywords: ['液压', '压力', '建压', '保压', '泄压', '蓄能器', '阀', '电磁阀', '换向阀', '阻尼', '缓冲器', '泵', '滤芯', '油位', '油温', '制动', '刹车', '水冷', '流量'],
    layers: ['液压泵将电能转换为压力能', '蓄能器和阀组决定压力响应时间常数', '节流孔/滤芯/阀芯改变流阻和有效流量', '执行机构压力不足或恢复缓慢触发保护'],
    failureModes: ['流阻增大导致建压或回压时间延长', '蓄能器预充不足导致压力缓冲能力下降', '阀组内泄或卡滞导致压力保持失败'],
    propagation: ['流量受限', '压力动态响应变慢', '执行机构动作反馈异常', '保护逻辑判定液压/制动异常'],
    observables: ['压力上升/下降时间', '泵启动频次与电流', '滤芯压差和油液状态', '机械压力表与HMI压力差异'],
    tests: ['机械压力表交叉验证HMI压力', '记录建压时间常数并与正常机组对比', '旁通/清理节流元件后复测压力恢复速度'],
    controls: ['控制油液清洁度和滤芯压差', '定期测蓄能器预充压力', '把隐蔽节流/阻尼元件纳入图纸和维护项'],
  },
  {
    id: 'mechanical_contact_wear',
    label: '载荷-润滑-接触疲劳机理',
    anchors: ['轴承', '齿轮', '齿轮箱', '主轴', '传动链', '振动', '磨损', '润滑'],
    keywords: ['轴承', '齿轮', '齿轮箱', '主轴', '传动链', '振动', '磨损', '剥落', '点蚀', '异响', '润滑', '油膜', '油样', '金属屑', '载荷', '不平衡', '叶片', '湍流'],
    layers: ['风载和转矩形成周期性接触应力', '润滑油膜隔离金属接触并带走热量', '污染/缺油/偏载破坏油膜和接触应力分布', '疲劳裂纹扩展为剥落、磨损和振动升高'],
    failureModes: ['油膜破裂导致边界润滑和三体磨损', '接触疲劳导致点蚀、剥落和冲击振动', '对中或载荷异常导致局部应力集中'],
    propagation: ['接触应力升高', '微点蚀和磨粒增多', '温升与振动频谱异常', '部件损伤扩展并触发停机保护'],
    observables: ['振动频谱和峭度', '轴承/齿轮箱温度趋势', '油样颗粒和金属磨屑', '异响和负载相关性'],
    tests: ['对比振动频谱特征频率', '取油样做颗粒/铁谱分析', '低负载与高负载趋势对比定位载荷相关性'],
    controls: ['建立油液颗粒趋势监测', '控制润滑周期和油品清洁度', '复核对中、密封和异常载荷来源'],
  },
  {
    id: 'electrical_thermal_stress',
    label: '电能变换-热应力-绝缘机理',
    anchors: ['变流', 'igbt', '母线', '电网', '箱变', '并网', '绝缘', '绕组', '发电机'],
    keywords: ['变流', '变流器', 'igbt', '母线', '电网', '箱变', '并网', '过流', '过压', '欠压', '接地', '防雷', '浪涌', '绝缘', '发电机', '绕组', '温度', '冷却', '散热'],
    layers: ['电网和发电机侧能量经功率器件变换', '电压/电流波动抬高器件电热应力', '散热、绝缘和接地条件决定裕量', '保护动作把电气异常转化为停机或降载'],
    failureModes: ['过压过流导致功率器件或驱动板应力超限', '散热不足导致温度裕量下降并热保护', '接地/浪涌/绝缘异常导致板卡或传感链损伤'],
    propagation: ['电气扰动进入功率回路', '器件温升或绝缘裕量下降', '驱动/保护板卡动作', '变流器或并网保护停机'],
    observables: ['直流母线电压', '网侧/机侧三相电流', 'IGBT或绕组温度', '保护动作记录和电能质量'],
    tests: ['读取故障前后母线和三相电流趋势', '核对散热风扇/水冷与温度曲线', '测绝缘、接地电阻和SPD状态'],
    controls: ['清理散热通道并监控温度裕量', '复核接地与浪涌保护', '把电网扰动与变流器保护记录关联分析'],
  },
  {
    id: 'signal_integrity_feedback',
    label: '传感-采集-控制反馈机理',
    anchors: ['plc', 'io', '反馈', '传感器', '编码器', '测量', '24v', '限位', '屏蔽', '接地'],
    keywords: ['plc', 'io', 'di', 'do', 'ai', '反馈', '传感器', '编码器', '测量', '漂移', '断线', '短路', '24v', '开关', '限位', '接插件', '端子', '屏蔽', '接地', 'scada', 'hmi', '温度跳变'],
    layers: ['现场传感器或触点产生状态/模拟量信号', '供电、屏蔽、接地和线缆决定信号完整性', 'PLC/采集模块把信号转为控制逻辑输入', '逻辑判断信号不可信或反馈不一致触发保护'],
    failureModes: ['接触不良或断线导致反馈丢失', '屏蔽接地差导致模拟量跳变或漂移', '传感器/采集通道偏差导致HMI显示与实测不一致'],
    propagation: ['信号质量下降', '采集值失真或状态抖动', '控制逻辑判定反馈缺失', '误报、禁止启动或保护停机'],
    observables: ['PLC原始输入点', 'HMI显示与现场实测差异', '通道倒换前后变化', '屏蔽接地和端子电压'],
    tests: ['现场实测值、PLC原始值和HMI三方比对', '倒换传感器或采集通道做反事实验证', '测量供电、端子压降和屏蔽接地连续性'],
    controls: ['规范屏蔽接地和强弱电分离', '定检紧固端子和接插件', '保留趋势数据用于区分真实异常与测量异常'],
  },
  {
    id: 'communication_network_loss',
    label: '通信链路时序与数据一致性机理',
    anchors: ['通信', '通讯', 'can', 'profibus', 'ethercat', '光纤', '心跳', '总线', '报文'],
    keywords: ['通信', '通讯', 'can', 'profibus', 'ethercat', '光纤', '交换机', '心跳', '超时', '丢包', '总线', '报文', '控制板', 'dsp'],
    layers: ['控制器通过现场总线交换状态和命令', '供电、终端电阻、光纤衰减和接插件决定链路质量', '报文延迟/丢包破坏控制时序一致性', '心跳超时或站点诊断触发通信保护'],
    failureModes: ['链路中断导致心跳丢失', '端接或接插件异常导致间歇性丢包', '控制板供电异常导致报文停止或状态冻结'],
    propagation: ['链路质量下降', '心跳/站点诊断异常', '控制命令和反馈不同步', '通信类停机或降级保护'],
    observables: ['总线诊断字', '心跳报文和超时计数', '端口灯/光功率/终端电阻', '控制板供电和状态灯'],
    tests: ['检查端口灯、光纤衰减和终端电阻', '替换线缆/接插件观察故障是否转移', '抓取通信报文或读取站点诊断历史'],
    controls: ['固定通信线缆和屏蔽层', '建立端口和光功率巡检', '记录通信超时与工况时序'],
  },
  {
    id: 'protection_logic_sequence',
    label: '保护链与工况边界判定机理',
    anchors: ['安全链', '急停', '保护', '复位', '禁止启动', '工况边界', '联锁', '限位'],
    keywords: ['安全链', '急停', '保护', '复位', '禁止启动', '报警逻辑', '工况边界', 'scada', '状态量', '误报', '联锁', '限位', '扭缆'],
    layers: ['控制系统采集安全、限位和工况状态', '保护逻辑按时序、阈值和互锁条件判定风险', '状态不一致或越界触发停机/禁止启动', '复位前必须确认风险解除并闭环验证'],
    failureModes: ['安全链开路或急停状态未复归', '限位/工况边界触发互锁保护', '状态量时序异常导致报警关联误判'],
    propagation: ['状态量越界或不一致', '保护逻辑置位', '停机或禁止自启动', '人工复位前需要确认风险解除'],
    observables: ['安全链电压和急停状态', '限位开关与互锁条件', '报警前后状态量时序', '复位后保护是否再次置位'],
    tests: ['拉取报警前后状态量时序', '逐点确认安全链和限位反馈', '复位后观察保护位和关联状态是否同步恢复'],
    controls: ['维护安全链点表和复位流程', '对工况边界报警建立时序审计', '把互锁条件纳入现场排查清单'],
  },
]

const MECHANISM_DISCRIMINATORS = [
  {
    archetypes: ['hydraulic_flow_restriction', 'signal_integrity_feedback'],
    question: '是真实压力/动作异常，还是压力传感与采集链路异常？',
    evidences: ['机械压力表与HMI压力是否一致', 'PLC原始AI/DI值是否与现场仪表一致', '清理节流元件后压力动态是否实质改善'],
    tests: ['用机械压力表复测压力曲线', '倒换传感器或AI通道观察异常是否随通道转移', '旁通/清理节流件后复测建压时间'],
    rules: ['机械表异常且清理节流件后改善，支持液压流阻机理', '机械表正常但HMI/PLC异常，支持信号完整性机理'],
  },
  {
    archetypes: ['mechanical_contact_wear', 'signal_integrity_feedback'],
    question: '是真实机械磨损升温/振动，还是测量链路导致的假异常？',
    evidences: ['振动频谱是否出现特征频率', '油样是否有金属颗粒或污染', '温度/振动传感器倒换后异常是否转移'],
    tests: ['做振动频谱和峭度分析', '取油样做颗粒和铁谱分析', '倒换传感器或采集通道验证测量链路'],
    rules: ['频谱和油样均异常，支持机械接触疲劳机理', '倒换通道后异常转移，支持信号采集机理'],
  },
  {
    archetypes: ['electrical_thermal_stress', 'signal_integrity_feedback'],
    question: '是真实电热应力异常，还是温度/电气测量信号受干扰？',
    evidences: ['温度跳变是否只在并网或大负荷时出现', '母线电压/三相电流是否同步异常', '屏蔽接地和通道倒换是否改变异常'],
    tests: ['对齐母线、电流、负荷和温度趋势', '测量屏蔽接地连续性并复测温度曲线', '倒换测温通道或切换备用传感器'],
    rules: ['电气量与温升同步变化，支持电热应力机理', '通道倒换或接地整改后跳变消失，支持信号完整性机理'],
  },
  {
    archetypes: ['communication_network_loss', 'signal_integrity_feedback'],
    question: '是总线通信链路异常，还是局部传感/IO反馈异常？',
    evidences: ['是否存在心跳超时或站点诊断字', '端口灯/光功率/终端电阻是否异常', '局部端子电压和PLC点位是否稳定'],
    tests: ['读取总线诊断和超时计数', '替换通信线缆或接插件观察故障是否转移', '测量局部IO供电和端子电压'],
    rules: ['多个站点或心跳异常，支持通信链路机理', '单点反馈异常且总线正常，支持信号反馈机理'],
  },
  {
    archetypes: ['protection_logic_sequence', 'signal_integrity_feedback'],
    question: '是真实保护链/工况越界，还是反馈信号造成的保护误判？',
    evidences: ['安全链电压和急停状态是否真实断开', '报警前后状态量时序是否满足保护逻辑', '现场触点状态是否与PLC/HMI一致'],
    tests: ['逐点确认安全链、急停和限位反馈', '拉取报警前后状态量时序', '复位后观察保护位是否再次置位'],
    rules: ['现场状态和保护逻辑一致，支持保护链机理', '现场状态正常但采集状态异常，支持信号完整性机理'],
  },
  {
    archetypes: ['hydraulic_flow_restriction', 'mechanical_contact_wear'],
    question: '是流体/润滑通道阻塞，还是轴承齿轮接触损伤？',
    evidences: ['滤芯压差和油液状态是否异常', '振动频谱是否出现轴承/齿轮特征频率', '温升是否与负载和润滑压力同步'],
    tests: ['更换滤芯或清理油路后复测温升和压力', '做振动频谱与油样颗粒分析', '对比低负载和高负载下的温升曲线'],
    rules: ['清理油路后快速改善，支持流阻/润滑通道机理', '频谱和油样仍异常，支持机械接触疲劳机理'],
  },
]

const SINGLE_ARCHETYPE_DISCRIMINATORS = {
  hydraulic_flow_restriction: {
    question: '是真实液压/流阻机理异常，还是压力测量、工况边界或控制时序造成的表观异常？',
    evidences: ['机械压力表曲线是否与HMI/PLC趋势一致', '建压/泄压时间常数是否偏离同型正常机组', '异常是否只在特定动作指令或低温/高温工况下出现'],
    tests: ['用机械压力表同步记录建压、保压和泄压曲线', '清理滤芯/节流件或旁通可疑阀件后复测压力响应', '对齐动作指令、泵电流、压力和反馈点时序'],
    rules: ['机械压力和动态响应同步异常，支持液压能量建立或流阻机理', '现场压力正常但采集值异常，支持测量链路或控制时序伪因'],
  },
  mechanical_contact_wear: {
    question: '是真实接触疲劳/磨损机理，还是传感器、载荷瞬态或运行边界导致的表观振动/温升？',
    evidences: ['振动频谱是否出现轴承或齿轮特征频率', '油样颗粒、铁谱或内窥镜是否支持磨损', '温升/振动是否与负载、转速和偏航工况稳定相关'],
    tests: ['做振动频谱、峭度和包络分析', '取油样做颗粒计数和铁谱分析', '对比低负载、高负载和不同转速下的趋势斜率'],
    rules: ['频谱、油样和负载相关性同时成立，支持接触疲劳/磨损机理', '倒换传感器或改变采集通道后异常转移，支持测量伪因'],
  },
  electrical_thermal_stress: {
    question: '是真实电热/绝缘应力异常，还是温度采集、并网扰动或保护记录关联造成的表观异常？',
    evidences: ['母线电压、三相电流与温度是否同步变化', '散热、水冷或风扇状态是否解释温升斜率', '绝缘、接地和SPD状态是否存在劣化证据'],
    tests: ['对齐并网状态、母线、电流、负荷和温度趋势', '复测散热通道、水冷流量和温度传感通道', '测量绝缘电阻、接地电阻和SPD状态'],
    rules: ['电气量、散热状态和温升趋势闭合，支持电热/绝缘应力机理', '电气量正常但测温通道倒换后异常转移，支持采集伪因'],
  },
  signal_integrity_feedback: {
    question: '是真实传感/反馈链路异常，还是被测对象本体已经发生物理异常？',
    evidences: ['现场实测值、PLC原始值和HMI显示是否一致', '端子电压、屏蔽接地和供电压降是否异常', '倒换传感器或采集通道后异常是否随通道转移'],
    tests: ['现场实测、PLC原始点和HMI三方比对', '测量供电、端子压降和屏蔽接地连续性', '倒换传感器、线缆或采集通道做反事实验证'],
    rules: ['异常随传感器/通道转移，支持信号完整性机理', '独立仪表也复现异常，支持被测对象本体机理'],
  },
  communication_network_loss: {
    question: '是真实通信链路/时序一致性异常，还是单站点设备掉电、IO反馈或配置边界造成的通信表象？',
    evidences: ['心跳超时、站点诊断字和丢包计数是否同步异常', '端口灯、光功率、终端电阻和接插件是否异常', '单站点供电和控制板状态是否稳定'],
    tests: ['读取总线诊断、心跳超时计数和历史报文', '替换线缆/光纤/接插件观察故障是否转移', '测量站点供电并复核地址、终端和配置'],
    rules: ['多站点超时或链路物理量异常，支持通信链路机理', '单站点掉电或局部反馈异常，支持设备/IO局部伪因'],
  },
  protection_logic_sequence: {
    question: '是真实保护链/工况边界触发，还是状态量采集、复位时序或报警关联导致的误判？',
    evidences: ['安全链电压、急停和限位触点是否真实动作', '报警前后状态量时序是否满足保护逻辑', '复位后保护位是否按逻辑解除并保持稳定'],
    tests: ['逐点测量安全链、急停和限位反馈', '拉取报警前后状态量和保护位时序', '按流程复位后观察保护位、互锁条件和关联状态'],
    rules: ['现场触点、状态时序和保护位一致，支持保护链/工况边界机理', '现场触点正常但状态量异常，支持采集或复位时序误判'],
  },
}

await main()

async function main() {
  const mechanismGraph = JSON.parse(await readFile(FAULT_MECHANISM_GRAPH, 'utf8'))
  const pdfQa = await readJsonIfExists(PDF_QA_CACHE, [])
  const windQuestionText = await readTextIfExists(WIND_QUESTIONS, '')
  const graph = buildReasoningGraph(mechanismGraph, pdfQa, windQuestionText)
  await mkdir(dirname(OUT_FILE), { recursive: true })
  await writeFile(OUT_FILE, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  console.log(`Built Windrise reasoning graph: ${OUT_FILE}`)
  console.log(`Nodes: ${graph.nodes.length}`)
  console.log(`Edges: ${graph.edges.length}`)
  console.log(`Aliases: ${graph.aliases.length}`)
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

async function readTextIfExists(filePath, fallback) {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return fallback
  }
}

function buildReasoningGraph(sourceGraph, pdfQa, windQuestionText) {
  const sourceNodes = new Map((sourceGraph.nodes || []).map(node => [node.id, node]))
  const sourceEdges = sourceGraph.edges || []
  const nodes = new Map()
  const edges = new Map()
  const aliases = []
  const cases = []

  for (const mechanismId of IMPORTANT_MECHANISM_IDS) {
    const mechanism = sourceNodes.get(mechanismId)
    if (!mechanism) continue
    const caseId = mechanismId.replace(/^mechanism:/, 'case:llmwiki_')
    const props = mechanism.properties || {}
    addNode(nodes, {
      id: caseId,
      type: 'fault_case',
      label: mechanism.label,
      aliases: buildMechanismAliases(mechanism),
      properties: {
        source: 'LLMWiki fault mechanism graph',
        mechanismId,
        system: props.system || '',
        component: props.component || '',
        summary: props.summary || '',
        localFaultRecords: props.localFaultRecords || mechanism.count || 0,
        examples: (props.examples || []).slice(0, 6),
      },
    })
    cases.push({ id: caseId, label: mechanism.label })
    for (const alias of buildMechanismAliases(mechanism)) aliases.push([alias, caseId])

    addSummaryNodes(nodes, edges, caseId, mechanism)
    addMechanismNeighborhood(nodes, edges, sourceNodes, sourceEdges, mechanismId, caseId)
    addExampleFaultRecords(nodes, edges, caseId, props.examples || [])
  }

  addPdfQaEvidence(nodes, edges, aliases, pdfQa)
  addWindQuestionRouteNodes(nodes, edges, aliases, windQuestionText)
  addSystemDomains(nodes, edges, aliases)
  addCuratedCaseStubs(nodes, aliases)
  addMechanismArchetypeLayer(nodes, edges, aliases)
  const nodeList = [...nodes.values()]
  const edgeList = [...edges.values()]
  const retrievalProfiles = buildRetrievalProfiles(nodeList, edgeList, aliases)
  const weightedAliases = buildWeightedAliases(retrievalProfiles)
  const qualitySummary = summarizeReasoningGraphQuality(nodeList, edgeList, aliases, retrievalProfiles)

  return {
    title: 'Windrise LLMWiki reasoning graph',
    generatedAt: new Date().toISOString(),
    source: [
      'wind-llmwiki/graph/fault-mechanism/knowledge-graph.json',
      'generated-knowledge/pdf-question-answer-cache.json',
      'generated-knowledge/wind-operation-maintenance-questions.md',
    ],
    description: 'Frontend-sized reasoning graph distilled from the LLMWiki fault-mechanism graph, PDF QA prompts, and wind O&M question set.',
    nodes: nodeList,
    edges: edgeList,
    aliases: uniqueAliasPairs(aliases),
    weighted_aliases: weightedAliases,
    retrieval_profiles: retrievalProfiles,
    quality_summary: qualitySummary,
    cases: uniqueBy(cases, item => item.id),
    system_domains: SYSTEM_DOMAINS.map(domain => ({
      id: domain.id,
      label: domain.label,
      keywords: domain.keywords,
      case_ids: domain.caseIds,
      subsystems: (domain.subsystems || []).map(subsystem => ({
        id: subsystem.id,
        label: subsystem.label,
        anchors: subsystem.anchors || [],
        keywords: subsystem.keywords,
        case_ids: subsystem.caseIds,
        signals: subsystem.signals,
        first_actions: subsystem.firstActions,
      })),
    })),
  }
}

function buildRetrievalProfiles(nodes, edges, aliases) {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const outgoingBySource = new Map()
  for (const edge of edges) {
    if (!outgoingBySource.has(edge.source)) outgoingBySource.set(edge.source, [])
    outgoingBySource.get(edge.source).push(edge)
  }
  const aliasMap = new Map()
  for (const [alias, caseId] of aliases) {
    if (!alias || !caseId) continue
    if (!aliasMap.has(caseId)) aliasMap.set(caseId, new Set())
    aliasMap.get(caseId).add(clean(alias).toLowerCase())
  }

  return nodes
    .filter(node => node.type === 'fault_case')
    .map(caseNode => {
      const profile = {
        case_id: caseNode.id,
        label: caseNode.label,
        system: caseNode.properties?.system || '',
        component: caseNode.properties?.component || '',
        summary: caseNode.properties?.summary || '',
        local_fault_records: caseNode.properties?.localFaultRecords || 0,
        high_confidence_terms: [],
        component_terms: [],
        symptom_terms: [],
        signal_terms: [],
        cause_terms: [],
        action_terms: [],
        diagnostic_step_terms: [],
        mechanism_terms: [],
        failure_mode_terms: [],
        verification_terms: [],
        hypothesis_terms: [],
        decision_terms: [],
        reasoning_plan_terms: [],
        evidence_gap_terms: [],
        exclusion_terms: [],
        weak_terms: [],
        evidence_counts: {},
        quality_score: 0,
      }

      addTerms(profile.high_confidence_terms, [caseNode.label, caseNode.properties?.component])
      addTerms(profile.high_confidence_terms, caseNode.aliases || [])
      addTerms(profile.high_confidence_terms, Array.from(aliasMap.get(caseNode.id) || []))
      addTerms(profile.high_confidence_terms, exampleTerms(caseNode.properties?.examples || []))

      for (const edge of edges) {
        if (edge.source !== caseNode.id && edge.target !== caseNode.id) continue
        profile.evidence_counts[edge.type] = (profile.evidence_counts[edge.type] || 0) + 1
        const other = byId.get(edge.source === caseNode.id ? edge.target : edge.source)
        if (!other) continue
        if (other.type === 'component' || other.type === 'system' || other.type === 'system_domain' || other.type === 'subsystem') {
          addTerms(profile.component_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'symptom') {
          addTerms(profile.symptom_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'diagnostic_signal') {
          addTerms(profile.signal_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'causal_factor') {
          addTerms(profile.cause_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'action') {
          addTerms(profile.action_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'diagnostic_step') {
          addTerms(profile.diagnostic_step_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'mechanism_archetype' || other.type === 'mechanism_layer' || other.type === 'propagation_step') {
          addTerms(profile.mechanism_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'failure_mode') {
          addTerms(profile.failure_mode_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'verification_test' || other.type === 'observable') {
          addTerms(profile.verification_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'diagnostic_hypothesis' || other.type === 'discriminating_evidence') {
          addTerms(profile.hypothesis_terms, [other.label, ...(other.aliases || [])])
          if (other.type === 'diagnostic_hypothesis') {
            for (const hypothesisEdge of outgoingBySource.get(other.id) || []) {
              const hypothesisTarget = byId.get(hypothesisEdge.target)
              if (!hypothesisTarget) continue
              if (hypothesisTarget.type === 'discriminating_evidence') {
                addTerms(profile.hypothesis_terms, [hypothesisTarget.label, ...(hypothesisTarget.aliases || [])])
              } else if (hypothesisTarget.type === 'counterfactual_test' || hypothesisTarget.type === 'decision_rule') {
                addTerms(profile.decision_terms, [hypothesisTarget.label, ...(hypothesisTarget.aliases || [])])
              }
            }
          }
        } else if (other.type === 'counterfactual_test' || other.type === 'decision_rule') {
          addTerms(profile.decision_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'reasoning_plan') {
          addPhraseTerms(profile.reasoning_plan_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'evidence_gap' || other.type === 'symptom_signature') {
          addPhraseTerms(profile.evidence_gap_terms, [other.label, ...(other.aliases || [])])
        } else if (other.type === 'exclusion_rule') {
          addPhraseTerms(profile.exclusion_terms, [other.label, ...(other.aliases || [])])
        }
      }

      const buckets = [
        profile.high_confidence_terms,
        profile.component_terms,
        profile.symptom_terms,
        profile.signal_terms,
        profile.cause_terms,
        profile.action_terms,
        profile.diagnostic_step_terms,
        profile.mechanism_terms,
        profile.failure_mode_terms,
        profile.verification_terms,
        profile.hypothesis_terms,
        profile.decision_terms,
        profile.reasoning_plan_terms,
        profile.evidence_gap_terms,
        profile.exclusion_terms,
      ]
      const weak = new Set()
      for (const bucket of buckets) {
        const strongTerms = []
        for (const term of unique(bucket)) {
          if (isWeakAlias(term)) {
            weak.add(term)
          } else {
            strongTerms.push(term)
          }
        }
        bucket.splice(0, bucket.length, ...strongTerms.slice(0, 24))
      }
      profile.weak_terms = [...weak].slice(0, 24)
      profile.quality_score = scoreRetrievalProfile(profile)
      return profile
    })
    .sort((a, b) => b.quality_score - a.quality_score || a.label.localeCompare(b.label, 'zh-Hans-CN'))
}

function buildWeightedAliases(profiles) {
  const pairs = []
  for (const profile of profiles) {
    addWeightedTerms(pairs, profile.case_id, profile.high_confidence_terms, 72, 'case')
    addWeightedTerms(pairs, profile.case_id, profile.component_terms, 48, 'component')
    addWeightedTerms(pairs, profile.case_id, profile.symptom_terms, 46, 'symptom')
    addWeightedTerms(pairs, profile.case_id, profile.signal_terms, 44, 'signal')
    addWeightedTerms(pairs, profile.case_id, profile.cause_terms, 42, 'cause')
    addWeightedTerms(pairs, profile.case_id, profile.mechanism_terms, 40, 'mechanism')
    addWeightedTerms(pairs, profile.case_id, profile.failure_mode_terms, 38, 'failure_mode')
    addWeightedTerms(pairs, profile.case_id, profile.verification_terms, 36, 'verification')
    addWeightedTerms(pairs, profile.case_id, profile.hypothesis_terms, 35, 'hypothesis')
    addWeightedTerms(pairs, profile.case_id, profile.decision_terms, 34, 'decision')
    addWeightedTerms(pairs, profile.case_id, profile.reasoning_plan_terms, 37, 'reasoning_plan')
    addWeightedTerms(pairs, profile.case_id, profile.evidence_gap_terms, 36, 'evidence_gap')
    addWeightedTerms(pairs, profile.case_id, profile.exclusion_terms, 34, 'exclusion')
    addWeightedTerms(pairs, profile.case_id, profile.diagnostic_step_terms, 30, 'diagnostic_step')
    addWeightedTerms(pairs, profile.case_id, profile.action_terms, 24, 'action')
    addWeightedTerms(pairs, profile.case_id, profile.weak_terms, 8, 'weak')
  }
  return uniqueWeightedAliases(pairs)
}

function summarizeReasoningGraphQuality(nodes, edges, aliases, profiles) {
  const edgeCounts = edges.reduce((acc, edge) => {
    acc[edge.type] = (acc[edge.type] || 0) + 1
    return acc
  }, {})
  const weakAliasCount = uniqueAliasPairs(aliases).filter(([alias]) => isWeakAlias(alias)).length
  const completeProfiles = profiles.filter(profile =>
    profile.cause_terms.length &&
    profile.symptom_terms.length &&
    profile.signal_terms.length &&
    (profile.action_terms.length || profile.diagnostic_step_terms.length),
  ).length
  const mechanismCoveredProfiles = profiles.filter(profile =>
    profile.mechanism_terms.length && profile.failure_mode_terms.length && profile.verification_terms.length,
  ).length
  const mechanismNodeCount = nodes.filter(node =>
    [
      'mechanism_archetype',
      'mechanism_layer',
      'failure_mode',
      'propagation_step',
      'observable',
      'verification_test',
      'control_barrier',
      'diagnostic_hypothesis',
      'discriminating_evidence',
      'counterfactual_test',
      'decision_rule',
      'symptom_signature',
      'evidence_gap',
      'exclusion_rule',
      'reasoning_plan',
    ].includes(node.type),
  ).length
  const mechanismEdgeCount = edges.filter(edge =>
    [
      'EXPLAINED_BY_ARCHETYPE',
      'HAS_MECHANISM_LAYER',
      'MECHANISM_PROPAGATES_TO',
      'MECHANISM_RESULTS_IN',
      'HAS_FAILURE_MODE',
      'HAS_PROPAGATION_START',
      'HAS_PROPAGATION_STEP',
      'HAS_OBSERVABLE',
      'VALIDATES_ARCHETYPE',
      'VERIFIED_BY_TEST',
      'CONTROLLED_BY_BARRIER',
      'HAS_COMPETING_HYPOTHESIS',
      'DISCRIMINATES_ARCHETYPE',
      'REQUIRES_DISCRIMINATING_EVIDENCE',
      'RESOLVED_BY_COUNTERFACTUAL_TEST',
      'HAS_DECISION_RULE',
      'HAS_SYMPTOM_SIGNATURE',
      'HAS_EVIDENCE_GAP',
      'HAS_EXCLUSION_RULE',
      'HAS_REASONING_PLAN',
    ].includes(edge.type),
  ).length
  const discriminatedProfiles = profiles.filter(profile =>
    profile.hypothesis_terms?.length && profile.decision_terms?.length,
  ).length
  const reasoningClosureProfiles = profiles.filter(profile =>
    profile.reasoning_plan_terms?.length && profile.evidence_gap_terms?.length && profile.exclusion_terms?.length,
  ).length
  return {
    node_count: nodes.length,
    edge_count: edges.length,
    alias_count: uniqueAliasPairs(aliases).length,
    weak_alias_count: weakAliasCount,
    weighted_alias_count: buildWeightedAliases(profiles).length,
    fault_case_count: profiles.length,
    complete_profile_count: completeProfiles,
    mechanism_archetype_count: MECHANISM_ARCHETYPES.length,
    mechanism_node_count: mechanismNodeCount,
    mechanism_edge_count: mechanismEdgeCount,
    mechanism_covered_profile_count: mechanismCoveredProfiles,
    mechanism_coverage_rate: profiles.length ? Number((mechanismCoveredProfiles / profiles.length).toFixed(3)) : 0,
    discriminated_profile_count: discriminatedProfiles,
    discrimination_coverage_rate: profiles.length ? Number((discriminatedProfiles / profiles.length).toFixed(3)) : 0,
    reasoning_closure_profile_count: reasoningClosureProfiles,
    reasoning_closure_coverage_rate: profiles.length ? Number((reasoningClosureProfiles / profiles.length).toFixed(3)) : 0,
    average_profile_quality: profiles.length
      ? Number((profiles.reduce((sum, profile) => sum + profile.quality_score, 0) / profiles.length).toFixed(1))
      : 0,
    edge_counts: edgeCounts,
  }
}

function addSystemDomains(nodes, edges, aliases) {
  for (const domain of SYSTEM_DOMAINS) {
    addNode(nodes, {
      id: domain.id,
      type: 'system_domain',
      label: domain.label,
      aliases: domain.keywords,
      properties: {
        keywords: domain.keywords,
        caseIds: domain.caseIds,
      },
    })
    for (const caseId of domain.caseIds) {
      addEdge(edges, caseId, 'INVOLVES_COMPONENT', domain.id, ['Windrise system domain'])
    }
    for (const keyword of domain.keywords) {
      for (const caseId of domain.caseIds) aliases.push([keyword, caseId])
    }
    for (const subsystem of domain.subsystems || []) {
      addNode(nodes, {
        id: subsystem.id,
        type: 'subsystem',
        label: subsystem.label,
        aliases: subsystem.keywords,
        properties: {
          domainId: domain.id,
          domainLabel: domain.label,
          keywords: subsystem.keywords,
          anchors: subsystem.anchors || [],
          caseIds: subsystem.caseIds,
          signals: subsystem.signals,
          firstActions: subsystem.firstActions,
        },
      })
      addEdge(edges, domain.id, 'INVOLVES_COMPONENT', subsystem.id, ['Windrise subsystem taxonomy'])
      for (const caseId of subsystem.caseIds) {
        addEdge(edges, caseId, 'INVOLVES_COMPONENT', subsystem.id, ['Windrise subsystem taxonomy'])
        for (const signal of subsystem.signals || []) {
          const signalId = conceptId('diagnostic_signal', `${subsystem.label}:${signal}`)
          addNode(nodes, {
            id: signalId,
            type: 'diagnostic_signal',
            label: signal,
            properties: { domainId: domain.id, subsystemId: subsystem.id, source: 'Windrise subsystem taxonomy' },
          })
          addEdge(edges, caseId, 'DIAGNOSED_BY', signalId, ['Windrise subsystem signal'])
        }
        for (const action of subsystem.firstActions || []) {
          const actionId = conceptId('diagnostic_step', `${subsystem.label}:${action}`)
          addNode(nodes, {
            id: actionId,
            type: 'diagnostic_step',
            label: action,
            properties: { domainId: domain.id, subsystemId: subsystem.id, source: 'Windrise subsystem taxonomy' },
          })
          addEdge(edges, caseId, 'HAS_DIAGNOSTIC_STEP', actionId, ['Windrise first-check action'])
        }
      }
      for (const keyword of subsystem.keywords || []) {
        for (const caseId of subsystem.caseIds || []) aliases.push([keyword, caseId])
      }
      for (const anchor of subsystem.anchors || []) {
        for (const caseId of subsystem.caseIds || []) aliases.push([anchor, caseId])
      }
    }
  }
}

function addCuratedCaseStubs(nodes, aliases) {
  for (const item of CURATED_CASES) {
    addNode(nodes, {
      id: item.id,
      type: 'fault_case',
      label: item.label,
      aliases: item.aliases,
      properties: {
        source: 'curated parts graph',
        summary: '清洗版部件故障图谱案例，用于和 LLMWiki 补充图谱交叉路由。',
      },
    })
    for (const alias of item.aliases || []) aliases.push([alias, item.id])
  }
}

function addMechanismArchetypeLayer(nodes, edges, aliases) {
  const caseNodes = [...nodes.values()].filter(node => node.type === 'fault_case')
  for (const archetype of MECHANISM_ARCHETYPES) {
    addNode(nodes, {
      id: `archetype:${archetype.id}`,
      type: 'mechanism_archetype',
      label: archetype.label,
      aliases: archetype.keywords,
      properties: {
        source: 'Windrise mechanism archetype',
        keywords: archetype.keywords,
      },
    })
  }

  for (const caseNode of caseNodes) {
    const matches = matchMechanismArchetypes(caseNode, nodes, edges).slice(0, 2)
    for (const match of matches) {
      const archetype = match.archetype
      const archetypeId = `archetype:${archetype.id}`
      addEdge(edges, caseNode.id, 'EXPLAINED_BY_ARCHETYPE', archetypeId, [
        `matched keywords: ${match.matchedTerms.slice(0, 8).join(', ')}`,
      ])
      aliases.push([archetype.label, caseNode.id])
      for (const term of match.matchedTerms) aliases.push([term, caseNode.id])

      const previousLayerIds = []
      for (const [index, layer] of archetype.layers.entries()) {
        const layerId = conceptId('mechanism_layer', `${caseNode.id}:${archetype.id}:layer:${index}:${layer}`)
        addNode(nodes, {
          id: layerId,
          type: 'mechanism_layer',
          label: layer,
          properties: {
            caseId: caseNode.id,
            archetypeId,
            layerIndex: index + 1,
            source: 'Windrise mechanism archetype',
          },
        })
        addEdge(edges, archetypeId, 'HAS_MECHANISM_LAYER', layerId, ['Windrise mechanism archetype'])
        if (previousLayerIds.length) {
          addEdge(edges, previousLayerIds[previousLayerIds.length - 1], 'MECHANISM_PROPAGATES_TO', layerId, ['Windrise mechanism layer sequence'])
        }
        previousLayerIds.push(layerId)
      }

      const propagationIds = []
      for (const [index, step] of archetype.propagation.entries()) {
        const stepId = conceptId('propagation_step', `${caseNode.id}:${archetype.id}:propagation:${index}:${step}`)
        addNode(nodes, {
          id: stepId,
          type: 'propagation_step',
          label: step,
          properties: {
            caseId: caseNode.id,
            archetypeId,
            stepIndex: index + 1,
            source: 'Windrise mechanism archetype',
          },
        })
        addEdge(edges, caseNode.id, index === 0 ? 'HAS_PROPAGATION_START' : 'HAS_PROPAGATION_STEP', stepId, ['Windrise mechanism propagation'])
        if (previousLayerIds[index]) {
          addEdge(edges, previousLayerIds[index], 'MECHANISM_RESULTS_IN', stepId, ['Windrise mechanism archetype'])
        }
        if (propagationIds.length) {
          addEdge(edges, propagationIds[propagationIds.length - 1], 'MECHANISM_PROPAGATES_TO', stepId, ['Windrise mechanism propagation'])
        }
        propagationIds.push(stepId)
      }

      for (const mode of archetype.failureModes) {
        const modeId = conceptId('failure_mode', `${caseNode.id}:${archetype.id}:failure:${mode}`)
        addNode(nodes, {
          id: modeId,
          type: 'failure_mode',
          label: mode,
          properties: {
            caseId: caseNode.id,
            archetypeId,
            source: 'Windrise mechanism archetype',
          },
        })
        addEdge(edges, archetypeId, 'HAS_FAILURE_MODE', modeId, ['Windrise mechanism archetype'])
        addEdge(edges, modeId, 'CAN_TRIGGER', caseNode.id, ['Windrise failure mode'])
      }

      for (const observable of archetype.observables) {
        const observableId = conceptId('observable', `${caseNode.id}:${archetype.id}:observable:${observable}`)
        addNode(nodes, {
          id: observableId,
          type: 'observable',
          label: observable,
          properties: {
            caseId: caseNode.id,
            archetypeId,
            source: 'Windrise mechanism archetype',
          },
        })
        addEdge(edges, caseNode.id, 'HAS_OBSERVABLE', observableId, ['Windrise mechanism observable'])
        addEdge(edges, observableId, 'VALIDATES_ARCHETYPE', archetypeId, ['Windrise mechanism observable'])
      }

      for (const test of archetype.tests) {
        const testId = conceptId('verification_test', `${caseNode.id}:${archetype.id}:test:${test}`)
        addNode(nodes, {
          id: testId,
          type: 'verification_test',
          label: test,
          properties: {
            caseId: caseNode.id,
            archetypeId,
            source: 'Windrise mechanism archetype',
          },
        })
        addEdge(edges, caseNode.id, 'VERIFIED_BY_TEST', testId, ['Windrise mechanism verification'])
      }

      for (const control of archetype.controls) {
        const controlId = conceptId('control_barrier', `${caseNode.id}:${archetype.id}:control:${control}`)
        addNode(nodes, {
          id: controlId,
          type: 'control_barrier',
          label: control,
          properties: {
            caseId: caseNode.id,
            archetypeId,
            source: 'Windrise mechanism archetype',
          },
        })
        addEdge(edges, caseNode.id, 'CONTROLLED_BY_BARRIER', controlId, ['Windrise mechanism control barrier'])
      }
    }
    addMechanismDiscriminators(nodes, edges, aliases, caseNode, matches)
    addCaseReasoningClosure(nodes, edges, aliases, caseNode, matches)
  }
}

function addCaseReasoningClosure(nodes, edges, aliases, caseNode, matches) {
  if (!matches?.length) return
  const primary = matches[0].archetype
  const secondary = matches[1]?.archetype || null
  const discriminators = matchingDiscriminators(matches)
  const observables = unique(matches.flatMap(match => match.archetype.observables || [])).slice(0, 5)
  const tests = unique(matches.flatMap(match => match.archetype.tests || [])).slice(0, 5)
  const failureModes = unique(matches.flatMap(match => match.archetype.failureModes || [])).slice(0, 4)
  const evidenceGaps = unique([
    ...(discriminators.flatMap(discriminator => discriminator.evidences || [])),
    ...tests,
  ]).slice(0, 5)
  const rules = unique(discriminators.flatMap(discriminator => discriminator.rules || [])).slice(0, 4)

  if (observables.length) {
    const label = `症状签名：${observables.slice(0, 3).join('；')}`
    const id = conceptId('symptom_signature', `${caseNode.id}:${label}`)
    addNode(nodes, {
      id,
      type: 'symptom_signature',
      label,
      aliases: observables,
      properties: {
        caseId: caseNode.id,
        archetypeIds: matches.map(match => `archetype:${match.archetype.id}`),
        source: 'Windrise reasoning closure',
      },
    })
    addEdge(edges, caseNode.id, 'HAS_SYMPTOM_SIGNATURE', id, ['Windrise reasoning closure'])
    for (const observable of observables) aliases.push([observable, caseNode.id])
  }

  if (failureModes.length && evidenceGaps.length) {
    const label = `证据缺口：定根因前需补齐${evidenceGaps.slice(0, 3).join('；')}`
    const id = conceptId('evidence_gap', `${caseNode.id}:${label}`)
    addNode(nodes, {
      id,
      type: 'evidence_gap',
      label,
      aliases: evidenceGaps,
      properties: {
        caseId: caseNode.id,
        targetFailureModes: failureModes,
        source: 'Windrise reasoning closure',
      },
    })
    addEdge(edges, caseNode.id, 'HAS_EVIDENCE_GAP', id, ['Windrise reasoning closure'])
    for (const gap of evidenceGaps) aliases.push([gap, caseNode.id])
  }

  for (const rule of rules) {
    const id = conceptId('exclusion_rule', `${caseNode.id}:${rule}`)
    addNode(nodes, {
      id,
      type: 'exclusion_rule',
      label: rule,
      aliases: [primary.label, secondary?.label].filter(Boolean),
      properties: {
        caseId: caseNode.id,
        primaryArchetypeId: `archetype:${primary.id}`,
        secondaryArchetypeId: secondary ? `archetype:${secondary.id}` : '',
        source: 'Windrise reasoning closure',
      },
    })
    addEdge(edges, caseNode.id, 'HAS_EXCLUSION_RULE', id, ['Windrise reasoning closure'])
    aliases.push([rule, caseNode.id])
  }

  const planParts = [
    observables[0] ? `先确认${observables[0]}` : '',
    tests[0] ? `再做${tests[0]}` : '',
    rules[0] ? `最后按规则判定：${rules[0]}` : '',
  ].filter(Boolean)
  if (planParts.length) {
    const label = `推理计划：${planParts.join('；')}`
    const id = conceptId('reasoning_plan', `${caseNode.id}:${label}`)
    addNode(nodes, {
      id,
      type: 'reasoning_plan',
      label,
      aliases: [primary.label, ...planParts],
      properties: {
        caseId: caseNode.id,
        archetypeIds: matches.map(match => `archetype:${match.archetype.id}`),
        source: 'Windrise reasoning closure',
      },
    })
    addEdge(edges, caseNode.id, 'HAS_REASONING_PLAN', id, ['Windrise reasoning closure'])
    aliases.push([label, caseNode.id])
  }
}

function matchingDiscriminators(matches) {
  const matchIds = new Set(matches.map(match => match.archetype.id))
  const pairwise = MECHANISM_DISCRIMINATORS.filter(discriminator =>
    discriminator.archetypes.every(id => matchIds.has(id)),
  )
  if (pairwise.length) return pairwise
  const primary = matches[0]?.archetype
  const fallback = primary ? SINGLE_ARCHETYPE_DISCRIMINATORS[primary.id] : null
  return fallback ? [fallback] : []
}

function addMechanismDiscriminators(nodes, edges, aliases, caseNode, matches) {
  if (!matches?.length) return
  const matchIds = new Set(matches.map(match => match.archetype.id))
  let addedSpecificDiscriminator = false
  for (const discriminator of MECHANISM_DISCRIMINATORS) {
    if (!discriminator.archetypes.every(id => matchIds.has(id))) continue
    addedSpecificDiscriminator = true
    const questionId = conceptId('diagnostic_hypothesis', `${caseNode.id}:${discriminator.archetypes.join('|')}:${discriminator.question}`)
    addNode(nodes, {
      id: questionId,
      type: 'diagnostic_hypothesis',
      label: discriminator.question,
      aliases: discriminator.archetypes,
      properties: {
        caseId: caseNode.id,
        archetypeIds: discriminator.archetypes.map(id => `archetype:${id}`),
        discriminatorType: 'pairwise_archetype_competition',
        source: 'Windrise mechanism discriminator',
      },
    })
    addEdge(edges, caseNode.id, 'HAS_COMPETING_HYPOTHESIS', questionId, ['Windrise mechanism discriminator'])
    aliases.push([discriminator.question, caseNode.id])

    for (const archetypeId of discriminator.archetypes) {
      addEdge(edges, questionId, 'DISCRIMINATES_ARCHETYPE', `archetype:${archetypeId}`, ['Windrise mechanism discriminator'])
    }

    for (const evidence of discriminator.evidences) {
      const evidenceId = conceptId('discriminating_evidence', `${caseNode.id}:${discriminator.question}:evidence:${evidence}`)
      addNode(nodes, {
        id: evidenceId,
        type: 'discriminating_evidence',
        label: evidence,
        properties: {
          caseId: caseNode.id,
          hypothesisId: questionId,
          source: 'Windrise mechanism discriminator',
        },
      })
      addEdge(edges, questionId, 'REQUIRES_DISCRIMINATING_EVIDENCE', evidenceId, ['Windrise mechanism discriminator'])
    }

    for (const test of discriminator.tests) {
      const testId = conceptId('counterfactual_test', `${caseNode.id}:${discriminator.question}:test:${test}`)
      addNode(nodes, {
        id: testId,
        type: 'counterfactual_test',
        label: test,
        properties: {
          caseId: caseNode.id,
          hypothesisId: questionId,
          source: 'Windrise mechanism discriminator',
        },
      })
      addEdge(edges, questionId, 'RESOLVED_BY_COUNTERFACTUAL_TEST', testId, ['Windrise mechanism discriminator'])
    }

    for (const rule of discriminator.rules) {
      const ruleId = conceptId('decision_rule', `${caseNode.id}:${discriminator.question}:rule:${rule}`)
      addNode(nodes, {
        id: ruleId,
        type: 'decision_rule',
        label: rule,
        properties: {
          caseId: caseNode.id,
          hypothesisId: questionId,
          source: 'Windrise mechanism discriminator',
        },
      })
      addEdge(edges, questionId, 'HAS_DECISION_RULE', ruleId, ['Windrise mechanism discriminator'])
    }
  }
  if (!addedSpecificDiscriminator) {
    addSingleArchetypeDiscriminator(nodes, edges, aliases, caseNode, matches[0].archetype)
  }
}

function addSingleArchetypeDiscriminator(nodes, edges, aliases, caseNode, archetype) {
  const discriminator = SINGLE_ARCHETYPE_DISCRIMINATORS[archetype.id]
  if (!discriminator) return
  const questionId = conceptId('diagnostic_hypothesis', `${caseNode.id}:${archetype.id}:single:${discriminator.question}`)
  addNode(nodes, {
    id: questionId,
    type: 'diagnostic_hypothesis',
    label: discriminator.question,
    aliases: [archetype.id, archetype.label],
    properties: {
      caseId: caseNode.id,
      archetypeIds: [`archetype:${archetype.id}`],
      discriminatorType: 'single_archetype_counterfactual',
      source: 'Windrise mechanism discriminator',
    },
  })
  addEdge(edges, caseNode.id, 'HAS_COMPETING_HYPOTHESIS', questionId, ['Windrise single-archetype counterfactual discriminator'])
  addEdge(edges, questionId, 'DISCRIMINATES_ARCHETYPE', `archetype:${archetype.id}`, ['Windrise single-archetype counterfactual discriminator'])
  aliases.push([discriminator.question, caseNode.id])

  for (const evidence of discriminator.evidences) {
    const evidenceId = conceptId('discriminating_evidence', `${caseNode.id}:${discriminator.question}:single:evidence:${evidence}`)
    addNode(nodes, {
      id: evidenceId,
      type: 'discriminating_evidence',
      label: evidence,
      properties: {
        caseId: caseNode.id,
        hypothesisId: questionId,
        source: 'Windrise single-archetype counterfactual discriminator',
      },
    })
    addEdge(edges, questionId, 'REQUIRES_DISCRIMINATING_EVIDENCE', evidenceId, ['Windrise single-archetype counterfactual discriminator'])
  }

  for (const test of discriminator.tests) {
    const testId = conceptId('counterfactual_test', `${caseNode.id}:${discriminator.question}:single:test:${test}`)
    addNode(nodes, {
      id: testId,
      type: 'counterfactual_test',
      label: test,
      properties: {
        caseId: caseNode.id,
        hypothesisId: questionId,
        source: 'Windrise single-archetype counterfactual discriminator',
      },
    })
    addEdge(edges, questionId, 'RESOLVED_BY_COUNTERFACTUAL_TEST', testId, ['Windrise single-archetype counterfactual discriminator'])
  }

  for (const rule of discriminator.rules) {
    const ruleId = conceptId('decision_rule', `${caseNode.id}:${discriminator.question}:single:rule:${rule}`)
    addNode(nodes, {
      id: ruleId,
      type: 'decision_rule',
      label: rule,
      properties: {
        caseId: caseNode.id,
        hypothesisId: questionId,
        source: 'Windrise single-archetype counterfactual discriminator',
      },
    })
    addEdge(edges, questionId, 'HAS_DECISION_RULE', ruleId, ['Windrise single-archetype counterfactual discriminator'])
  }
}

function matchMechanismArchetypes(caseNode, nodes, edges) {
  const context = buildCaseMechanismContext(caseNode, nodes, edges)
  const scored = []
  for (const archetype of MECHANISM_ARCHETYPES) {
    const matchedTerms = []
    const matchedAnchors = []
    let score = 0
    for (const keyword of archetype.keywords) {
      const key = clean(keyword).toLowerCase()
      if (!key || !context.includes(key)) continue
      matchedTerms.push(key)
      score += Math.min(18, Math.max(4, key.length))
    }
    for (const anchor of archetype.anchors || []) {
      const key = clean(anchor).toLowerCase()
      if (!key || !context.includes(key)) continue
      matchedAnchors.push(key)
      score += 14
    }
    if (context.includes(clean(archetype.label).toLowerCase())) score += 20
    const hasAnchor = matchedAnchors.length > 0
    const enoughSpecificEvidence = score >= 42 && matchedTerms.some(term => term.length >= 4 || /^[a-z]*\d{3,}/i.test(term))
    if (hasAnchor || enoughSpecificEvidence) {
      scored.push({
        archetype,
        score,
        matchedTerms: unique([...matchedAnchors, ...matchedTerms]),
      })
    }
  }
  return scored.sort((a, b) => b.score - a.score || a.archetype.label.localeCompare(b.archetype.label, 'zh-Hans-CN'))
}

function buildCaseMechanismContext(caseNode, nodes, edges) {
  const parts = [
    caseNode.label,
    ...(caseNode.aliases || []),
    caseNode.properties?.system,
    caseNode.properties?.component,
    caseNode.properties?.summary,
  ]
  for (const example of caseNode.properties?.examples || []) {
    parts.push(example.code, example.name, example.model, example.site)
  }
  for (const edge of edges) {
    if (edge.source !== caseNode.id && edge.target !== caseNode.id) continue
    const other = nodes.get(edge.source === caseNode.id ? edge.target : edge.source)
    if (!other) continue
    parts.push(other.label, ...(other.aliases || []), other.properties?.summary)
  }
  return clean(parts.filter(Boolean).join(' ')).toLowerCase()
}

function addSummaryNodes(nodes, edges, caseId, mechanism) {
  const props = mechanism.properties || {}
  if (props.system) {
    const id = conceptId('system', props.system)
    addNode(nodes, { id, type: 'system', label: props.system })
    addEdge(edges, caseId, 'INVOLVES_COMPONENT', id, ['LLMWiki system'])
  }
  if (props.component) {
    const id = conceptId('component', props.component)
    addNode(nodes, { id, type: 'component', label: props.component })
    addEdge(edges, caseId, 'INVOLVES_COMPONENT', id, ['LLMWiki component'])
  }
  if (props.summary) {
    const id = conceptId('principle', props.summary)
    addNode(nodes, { id, type: 'principle', label: props.summary })
    addEdge(edges, caseId, 'PRINCIPLE', id, ['LLMWiki mechanism summary'])
  }
}

function addMechanismNeighborhood(nodes, edges, sourceNodes, sourceEdges, mechanismId, caseId) {
  const wantedTypes = new Set([
    'CAN_TRIGGER',
    'MANIFESTS_AS',
    'DIAGNOSED_BY',
    'MITIGATED_BY',
    'INVOLVES_COMPONENT',
  ])
  const limits = {
    CAN_TRIGGER: 5,
    MANIFESTS_AS: 5,
    DIAGNOSED_BY: 5,
    MITIGATED_BY: 5,
    INVOLVES_COMPONENT: 3,
  }
  const counts = new Map()
  const relevant = sourceEdges
    .filter(edge => wantedTypes.has(edge.type))
    .filter(edge => edge.source === mechanismId || edge.target === mechanismId)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))

  for (const edge of relevant) {
    const count = counts.get(edge.type) || 0
    if (count >= (limits[edge.type] || 4)) continue
    counts.set(edge.type, count + 1)
    const otherId = edge.source === mechanismId ? edge.target : edge.source
    const other = sourceNodes.get(otherId)
    if (!other) continue
    const node = convertSourceNode(other)
    addNode(nodes, node)
    const source = edge.source === mechanismId ? caseId : node.id
    const target = edge.target === mechanismId ? caseId : node.id
    addEdge(edges, source, edge.type, target, edge.evidence || [])
  }
}

function addExampleFaultRecords(nodes, edges, caseId, examples) {
  for (const example of examples.slice(0, 4)) {
    const label = [example.code, example.name].filter(Boolean).join(' ')
    if (!label) continue
    const id = conceptId('diagnostic_signal', label)
    addNode(nodes, {
      id,
      type: 'diagnostic_signal',
      label,
      properties: {
        source: example.source || '',
        model: example.model || '',
        site: example.site || '',
      },
    })
    addEdge(edges, caseId, 'DIAGNOSED_BY', id, ['LLMWiki local fault record'])
  }
}

function addPdfQaEvidence(nodes, edges, aliases, pdfQa) {
  const routeRules = [
    [/偏航|阻尼|缓冲器|液压系统压力异常/, 'case:yaw_hydraulic_pressure'],
    [/T_?228|T_?229|偏航制动压力|压力传感器/, 'case:yaw_brake_pressure_sensor'],
    [/YX277|YX278|YX279|液压泵动作|蓄能器/, 'case:hydraulic_pump_runtime'],
    [/5806|Q16\.?1|断路器跳闸|液压泵断路器/, 'case:hydraulic_pump_breaker_trip'],
    [/代码65|故障代码65|A240\.?1|刹车泵无压力|制动器压力开关/, 'case:brake_pump_no_pressure'],
    [/192|193|194|编码器|偏航速度|偏航位置/, 'case:yaw_speed_encoder_feedback'],
  ]
  const items = Array.isArray(pdfQa) ? pdfQa : []
  for (const item of items) {
    const question = clean(item.question)
    const answer = clean(item.answer)
    if (!question || !answer) continue
    const text = `${question} ${answer} ${clean(item.section)}`
    const match = routeRules.find(([regex]) => regex.test(text))
    if (!match) continue
    const caseId = match[1]
    const qId = conceptId('diagnostic_signal', question)
    addNode(nodes, {
      id: qId,
      type: 'diagnostic_signal',
      label: question,
      properties: {
        source: 'PDF QA prompt',
        section: clean(item.section),
        dialog: clean(item.dialog),
      },
    })
    addEdge(edges, caseId, 'DIAGNOSED_BY', qId, ['PDF QA prompt'])
    for (const keyword of extractKeywords(question).slice(0, 3)) aliases.push([keyword, caseId])
  }
}

function addWindQuestionRouteNodes(nodes, edges, aliases, markdown) {
  const sections = parseQuestionMarkdown(markdown)
  const routeRules = [
    [/安全|许可|急停|安全链/, 'case:llmwiki_safety-chain-emergency-stop'],
    [/偏航|扭缆|解缆|角度|限位/, 'case:llmwiki_yaw-drive-brake-limit'],
    [/变桨|桨距|桨叶|叶片|轮毂/, 'case:llmwiki_pitch-actuator-position-error'],
    [/液压|制动|刹车|蓄能器|泵|阀/, 'case:llmwiki_hydraulic-station-pump-accumulator-valve'],
    [/齿轮箱|传动链|主轴|轴承|润滑|振动/, 'case:llmwiki_gearbox-bearing-gear-wear'],
    [/发电机|绕组|转子|定子|轴承温度/, 'case:llmwiki_generator-bearing-thermal-lubrication'],
    [/变流|变频|IGBT|母线|并网|电网|箱变/, 'case:llmwiki_converter-dc-link-grid-disturbance'],
    [/主控|通信|通讯|PLC|SCADA|HMI|传感器|反馈/, 'case:llmwiki_plc-io-feedback-chain'],
    [/定检|预防|复位|试运行|闭环/, 'case:llmwiki_scada-data-quality-alarm-correlation'],
  ]

  for (const section of sections) {
    for (const question of section.questions.slice(0, 8)) {
      const match = routeRules.find(([regex]) => regex.test(`${section.title} ${question}`))
      if (!match) continue
      const caseId = match[1]
      const qId = conceptId('diagnostic_step', question)
      addNode(nodes, {
        id: qId,
        type: 'diagnostic_step',
        label: question,
        properties: {
          source: 'wind O&M question set',
          section: section.title,
        },
      })
      addEdge(edges, caseId, 'HAS_DIAGNOSTIC_STEP', qId, ['wind O&M question set'])
      for (const keyword of extractKeywords(question).slice(0, 2)) aliases.push([keyword, caseId])
    }
  }
}

function parseQuestionMarkdown(text) {
  const sections = []
  let current = null
  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      current = { title: clean(heading[1]), questions: [] }
      sections.push(current)
      continue
    }
    const question = line.match(/^\s*\d+\.\s+(.+)$/)
    if (question && current) current.questions.push(clean(question[1]))
  }
  return sections
}

function convertSourceNode(node) {
  const typeMap = {
    mitigation: 'action',
    mechanism: 'fault_case',
  }
  return {
    id: node.id,
    type: typeMap[node.type] || node.type,
    label: node.label,
    aliases: node.aliases || [],
    properties: node.properties || {},
  }
}

function buildMechanismAliases(mechanism) {
  const props = mechanism.properties || {}
  const exampleCodes = (props.examples || [])
    .map(example => clean(example.code).toLowerCase())
    .filter(code => !/^\d{1,2}$/.test(code))
    .filter(Boolean)
  const labels = [
    mechanism.label,
    props.component,
  ]
  return unique([
    ...labels.flatMap(extractKeywords),
    ...labels.map(clean).filter(Boolean),
    ...exampleCodes,
  ]).filter(alias => !isWeakAlias(alias)).slice(0, 18)
}

function extractKeywords(value) {
  const text = clean(value)
  if (!text) return []
  const tokens = new Set()
  for (const match of text.matchAll(/[A-Za-z]*\d+[A-Za-z0-9_.-]*|[A-Za-z]+(?:[_-]?[A-Za-z0-9]+)*/g)) {
    tokens.add(match[0].toLowerCase())
  }
  for (const part of text.split(/[，。！？、；：,!?;:()\[\]【】\s/和或与及]+/)) {
    const cleaned = clean(part)
    if (cleaned.length >= 2 && cleaned.length <= 18) tokens.add(cleaned.toLowerCase())
  }
  return [...tokens].filter(item => {
    if (/^\d{1,2}$/.test(item)) return false
    return !/^(怎么|如何|什么|为什么|检查|处理|故障|报警|告警|系统)$/.test(item)
  })
}

function addNode(nodes, node) {
  if (!node?.id || !node.label) return
  if (!nodes.has(node.id)) {
    nodes.set(node.id, {
      ...node,
      label: clean(node.label),
      aliases: Array.isArray(node.aliases) ? unique(node.aliases.map(clean).filter(Boolean)) : [],
    })
    return
  }
  const current = nodes.get(node.id)
  current.aliases = unique([...(current.aliases || []), ...((node.aliases || []).map(clean))].filter(Boolean))
  current.properties = { ...(current.properties || {}), ...(node.properties || {}) }
}

function addEdge(edges, source, type, target, evidence = []) {
  if (!source || !type || !target) return
  const key = `${source}|${type}|${target}`
  if (edges.has(key)) return
  edges.set(key, {
    source,
    type,
    target,
    evidence: Array.isArray(evidence) ? evidence.slice(0, 5) : [String(evidence)].filter(Boolean),
  })
}

function conceptId(type, label) {
  return `${type}:${hash(clean(label))}`
}

function hash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function uniqueBy(items, keyFn) {
  const seen = new Set()
  const result = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function uniqueAliasPairs(pairs) {
  const seen = new Set()
  const result = []
  for (const [alias, caseId] of pairs) {
    const cleaned = clean(alias).toLowerCase()
    if (!isUsableAlias(cleaned) || !caseId) continue
    const key = `${cleaned}|${caseId}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push([cleaned, caseId])
  }
  return result
}

function addTerms(target, values) {
  for (const value of values || []) {
    for (const term of extractKeywords(value)) target.push(term)
    const cleaned = clean(value).toLowerCase()
    if (cleaned) target.push(cleaned)
  }
}

function addPhraseTerms(target, values) {
  for (const value of values || []) {
    const cleaned = clean(value).toLowerCase()
    if (!cleaned) continue
    if (cleaned.length <= 80) target.push(cleaned)
    for (const part of cleaned.split(/[；;，,]/)) {
      const phrase = clean(part).toLowerCase()
      if (phrase.length >= 4 && phrase.length <= 40) target.push(phrase)
    }
  }
}

function exampleTerms(examples) {
  const terms = []
  for (const example of examples || []) {
    const code = clean(example.code).toLowerCase()
    const name = clean(example.name).toLowerCase()
    if (code && !/^\d{1,2}$/.test(code)) terms.push(code)
    if (code && name) terms.push(`${code} ${name}`)
    if (name) terms.push(name)
  }
  return terms
}

function scoreRetrievalProfile(profile) {
  let score = 0
  score += Math.min(25, profile.high_confidence_terms.length * 2)
  score += Math.min(15, profile.cause_terms.length * 3)
  score += Math.min(15, profile.symptom_terms.length * 3)
  score += Math.min(15, profile.signal_terms.length * 3)
  score += Math.min(15, profile.action_terms.length * 3 + profile.diagnostic_step_terms.length * 2)
  score += Math.min(18, profile.mechanism_terms.length * 2)
  score += Math.min(12, profile.failure_mode_terms.length * 3)
  score += Math.min(10, profile.verification_terms.length * 2)
  score += Math.min(10, profile.hypothesis_terms.length * 2)
  score += Math.min(10, profile.decision_terms.length * 2)
  score += Math.min(12, profile.reasoning_plan_terms.length * 3)
  score += Math.min(10, profile.evidence_gap_terms.length * 2)
  score += Math.min(8, profile.exclusion_terms.length * 2)
  score += Math.min(10, Math.log10(Math.max(1, profile.local_fault_records)) * 5)
  score -= Math.min(12, profile.weak_terms.length)
  return Math.max(0, Math.round(score))
}

function addWeightedTerms(target, caseId, terms, baseWeight, source) {
  for (const term of terms || []) {
    if (!isUsableAlias(term)) continue
    const normalized = clean(term).toLowerCase()
    const lengthBonus = Math.min(18, Math.max(0, normalized.length - 2))
    const codeBonus = /^[a-z]*\d{3,}[a-z0-9_.-]*$/i.test(normalized) ? 18 : 0
    const weakPenalty = isWeakAlias(normalized) ? 20 : 0
    target.push([normalized, caseId, Math.max(1, baseWeight + lengthBonus + codeBonus - weakPenalty), source])
  }
}

function uniqueWeightedAliases(items) {
  const best = new Map()
  for (const [alias, caseId, weight, source] of items) {
    const cleaned = clean(alias).toLowerCase()
    if (!isUsableAlias(cleaned) || !caseId) continue
    const key = `${cleaned}|${caseId}`
    const current = best.get(key)
    if (!current || weight > current[2]) best.set(key, [cleaned, caseId, weight, source])
  }
  return [...best.values()].sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0], 'zh-Hans-CN'))
}

function isUsableAlias(value) {
  const alias = clean(value).toLowerCase()
  if (!alias || alias.length < 2) return false
  if (/^\d{1,2}$/.test(alias)) return false
  if (/^(怎么|如何|什么|为什么|是否|可以|需要|下一步|怎么办)$/.test(alias)) return false
  return true
}

function isWeakAlias(value) {
  const alias = clean(value).toLowerCase()
  if (!alias) return true
  if (WEAK_ALIAS_TERMS.has(alias)) return true
  if (/^(检查|处理|更换|确认|核对|测量|排查|复核|查看)/.test(alias) && alias.length <= 6) return true
  if (/^(故障|报警|告警|系统|信号|状态|异常|保护)$/.test(alias)) return true
  return false
}
