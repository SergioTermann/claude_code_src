import { createHash } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const FAULT_INDEX = join(ROOT, 'wind-llmwiki', 'fault-index.jsonl')
const OUT_DIR = join(ROOT, 'wind-llmwiki', 'graph', 'fault-mechanism')
const WIKI_FILE = join(ROOT, 'wind-llmwiki', 'wiki', 'fault-mechanisms.md')

const SOURCES = [
  {
    id: 'source:local-fault-index',
    label: '本地风机故障码索引',
    type: 'source',
    url: 'wind-llmwiki/fault-index.jsonl',
    note: '本项目从本地风机故障资料抽取的故障码、原因、处理、逻辑和来源路径。',
  },
  {
    id: 'source:pitch-hydraulic-diagnosis',
    label: 'Fault Diagnosis and Prognosis Capabilities for Wind Turbine Hydraulic Pitch Systems',
    type: 'source',
    url: 'https://arxiv.org/abs/2312.09018',
    note: '液压变桨系统诊断能力、常见故障和传感器可诊断性。',
  },
  {
    id: 'source:gearbox-vibration-diagnosis',
    label: 'Vibration Fault Diagnosis in Wind Turbines based on Automated Feature Learning',
    type: 'source',
    url: 'https://arxiv.org/abs/2201.13403',
    note: '风机齿轮箱等旋转部件可通过振动测量进行故障状态评估。',
  },
  {
    id: 'source:gearbox-scada-digital-twin',
    label: 'Digital Twin Framework for Time to Failure Forecasting of Wind Turbine Gearbox',
    type: 'source',
    url: 'https://arxiv.org/abs/2205.03513',
    note: '齿轮箱健康可用 SCADA 时间序列、温度、转速、功率等变量建模。',
  },
  {
    id: 'source:converter-open-circuit-review',
    label: 'Review for AI-based Open-Circuit Faults Diagnosis Methods in Power Electronics Converters',
    type: 'source',
    url: 'https://arxiv.org/abs/2209.14058',
    note: '电力电子变换器开路类故障特征和智能诊断方法综述。',
  },
  {
    id: 'source:iec-61400-25',
    label: 'IEC 61400-25 monitoring and control information model',
    type: 'source',
    url: 'https://webstore.iec.ch/searchform&q=61400-25',
    note: '风电场监控通信、信息模型和状态监测逻辑节点标准族。',
  },
]

const MECHANISMS = [
  mechanism({
    id: 'mechanism:pitch-24v-feedback-loss',
    label: '变桨24V控制电源或开关反馈丢失',
    system: '变桨系统',
    component: '24V控制电源/反馈开关',
    summary: '24V控制电源开关断开、线路短路断路或反馈触点异常，导致 PLC 采集不到有效反馈，触发停机或禁止自启动。',
    keywords: ['24v', '24V', '主电源', '电源开关', '反馈信号丢失', '反馈信号', '变桨'],
    causes: ['开关断开', '线路短路', '线路断路', '辅助触点异常', 'PLC输入异常'],
    symptoms: ['反馈丢失', '立即停机', '手动复位', '不能自启动'],
    signals: ['24V开关反馈', 'PLC DI状态', '变桨控制电源状态'],
    actions: ['检查24V主电源开关', '检查开关反馈线路', '检查短路/断路', '确认PLC输入点状态'],
    sources: ['source:local-fault-index', 'source:pitch-hydraulic-diagnosis', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:pitch-hydraulic-pressure-loss',
    label: '液压变桨压力不足或蓄能能力下降',
    system: '变桨系统',
    component: '液压泵/蓄能器/阀组',
    summary: '液压泵、阀组、蓄能器或管路泄漏会降低变桨执行力和响应速度，表现为压力低、动作超时或桨距跟踪误差。',
    keywords: ['液压', '油压', '压力', '蓄能器', '泄漏', '泵', '阀', '变桨', '桨距'],
    causes: ['蓄能器预充压力不足', '液压泄漏', '泵效率下降', '阀卡滞', '油温异常'],
    symptoms: ['压力低', '变桨超时', '桨距偏差', '紧急顺桨能力下降'],
    signals: ['液压压力', '油温', '泵启动频次', '桨距位置偏差'],
    actions: ['检查液压管路泄漏', '检查蓄能器压力', '检查泵和阀组', '核对桨距响应时间'],
    sources: ['source:pitch-hydraulic-diagnosis', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:pitch-actuator-position-error',
    label: '变桨执行机构卡滞或位置反馈异常',
    system: '变桨系统',
    component: '变桨驱动/编码器/限位开关',
    summary: '执行机构卡滞、编码器异常或限位开关误动作会造成桨距位置不可信或跟踪失败，进而触发超时、限位或同步类故障。',
    keywords: ['变桨', '桨距', '位置', '编码器', '限位', '超时', '同步', '驱动器', '卡滞'],
    causes: ['驱动器故障', '编码器故障', '限位开关误动作', '机械卡滞', '通信异常'],
    symptoms: ['桨距偏差', '位置超时', '限位触发', '三支叶片不同步'],
    signals: ['桨距角', '编码器反馈', '限位开关', '驱动器状态字'],
    actions: ['检查编码器与限位开关', '检查驱动器报警', '检查机械卡滞', '校验桨距零位'],
    sources: ['source:pitch-hydraulic-diagnosis', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:converter-dc-link-grid-disturbance',
    label: '变流器直流母线或电网电压扰动',
    system: '变流系统',
    component: '网侧变流器/直流母线/电网接口',
    summary: '电网电压跌落、过压欠压、直流母线能量不平衡或制动/并网控制异常，会造成变流器保护动作和功率受限。',
    keywords: ['变流', '变频', '直流母线', '母线', '过压', '欠压', '电网', '网侧', 'igbt', 'IGBT', 'GSC', 'LSC'],
    causes: ['电网电压扰动', '直流母线过压', 'IGBT开路或驱动异常', '接触器/断路器异常', '控制板故障'],
    symptoms: ['变流器跳闸', '过压保护', '欠压保护', '功率波动', '并网失败'],
    signals: ['直流母线电压', '三相电压电流', 'IGBT驱动状态', '变流器子故障码'],
    actions: ['检查电网电压', '读取变流器子故障', '检查接触器/断路器', '检查功率模块和控制板'],
    sources: ['source:converter-open-circuit-review', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:converter-control-communication-loss',
    label: '变流器控制板或通信链路中断',
    system: '变流系统',
    component: 'DSP板/CAN/光纤/PLC通信',
    summary: '变流器控制板、CAN/光纤链路或 PLC 通信异常会导致状态字缺失、控制命令不能闭环，常表现为通信故障或准备信号丢失。',
    keywords: ['DSP', '控制板', '通讯', '通信', 'CAN', '光纤', '状态字', '准备信号', '变频器', '变流器'],
    causes: ['通信链路断开', '控制板异常', '电源板异常', '接口松动', '参数或程序异常'],
    symptoms: ['通信故障', '状态丢失', '准备信号丢失', '无法并网'],
    signals: ['CAN状态', '光纤链路', '控制板指示灯', '变流器状态字'],
    actions: ['检查通信线缆和接口', '检查控制板电源', '检查参数和程序版本', '必要时更换控制板'],
    sources: ['source:converter-open-circuit-review', 'source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:generator-bearing-thermal-lubrication',
    label: '发电机轴承热-润滑-对中失效',
    system: '发电机系统',
    component: '发电机轴承',
    summary: '润滑不足、轴承损伤、对中不良或传感器异常会导致轴承温度升高和振动加剧，持续运行可能扩展为机械损伤。',
    keywords: ['发电机', '轴承', '温度', '润滑', '对中', '振动', '定子', '转子'],
    causes: ['润滑不足', '轴承磨损', '对中不良', '冷却不足', '温度传感器异常'],
    symptoms: ['轴承温度高', '振动升高', '温升快', '手动复位'],
    signals: ['轴承温度', '振动频谱', '润滑状态', '转速/功率工况'],
    actions: ['停机散热', '检查润滑', '检查传感器与线路', '检查发电机对中和轴承状态'],
    sources: ['source:gearbox-vibration-diagnosis', 'source:gearbox-scada-digital-twin', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:gearbox-bearing-gear-wear',
    label: '齿轮箱轴承或齿轮磨损导致振动与温升',
    system: '齿轮箱系统',
    component: '齿轮箱轴承/齿轮副',
    summary: '齿轮齿面磨损、轴承损伤、润滑劣化或载荷波动会改变振动频谱、油温和转速关系，是齿轮箱健康退化的核心机理。',
    keywords: ['齿轮箱', '齿轮', '轴承', '油温', '润滑', '振动', '啮合', '磨损'],
    causes: ['齿面磨损', '轴承损伤', '润滑油劣化', '冲击载荷', '油路异常'],
    symptoms: ['齿轮箱温度高', '振动高', '异响', '转速关系异常'],
    signals: ['振动频谱', '油温', '轴承温度', '转速比', '润滑油状态'],
    actions: ['检查润滑油', '分析振动频谱', '检查轴承和齿轮副', '结合SCADA趋势判断退化'],
    sources: ['source:gearbox-vibration-diagnosis', 'source:gearbox-scada-digital-twin', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:yaw-drive-brake-limit',
    label: '偏航驱动、制动或限位链路异常',
    system: '偏航系统',
    component: '偏航电机/制动器/限位开关',
    summary: '偏航电机、制动器、液压/电气限位和反馈链路异常会导致偏航不到位、偏航超时、扭缆或偏航压力类故障。',
    keywords: ['偏航', '制动', '电机', '限位', '扭缆', '偏航压力', '偏航角', 'yaw', 'Yaw'],
    causes: ['偏航电机故障', '制动器未释放', '限位开关异常', '偏航压力异常', '扭缆保护触发'],
    symptoms: ['偏航超时', '偏航角异常', '左右限位触发', '偏航压力高低'],
    signals: ['偏航角', '偏航电机电流', '制动器反馈', '限位开关'],
    actions: ['检查偏航电机', '检查制动器释放', '检查限位开关', '检查偏航液压/润滑'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:thermal-management-sensor-chain',
    label: '控制柜或机舱热管理与温度传感链异常',
    system: '温度系统',
    component: '温度传感器/风扇/加热器/控制柜',
    summary: '柜内散热、加热、风扇、断路器或温度采样链路异常，会造成温度超限或虚假温度报警。',
    keywords: ['温度', '高温', '低温', '传感器', '风扇', '加热', '冷却', '控制柜', '机舱柜', '塔底柜'],
    causes: ['实际温度超限', '传感器线路故障', '风扇或加热器故障', '断路器动作', 'PLC模块故障'],
    symptoms: ['温度超限', '温度信号异常', '风扇保护开关反馈丢失', '自动复位'],
    signals: ['柜内温度', '风扇反馈', '加热器反馈', 'PLC AI/DI状态'],
    actions: ['检查传感器线路', '检查风扇和加热器', '检查断路器辅助触点', '核实实际温度'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:plc-io-feedback-chain',
    label: 'PLC输入输出反馈链路异常',
    system: '主控系统',
    component: 'PLC模块/DI反馈/辅助触点',
    summary: '大量保护和执行机构依赖 PLC 采集反馈信号；当开关、辅助触点、线缆或模块异常时，故障表现为“反馈信号丢失”而不一定是本体失效。',
    keywords: ['PLC', '反馈', '辅助触点', '信号丢失', 'DI', '输入点', '模块', '开关反馈', '接收不到'],
    causes: ['PLC模块故障', '辅助触点故障', '线路断开', '端子松动', '开关未闭合'],
    symptoms: ['反馈丢失', '状态不一致', '保护开关动作', '无法自动复位'],
    signals: ['PLC DI状态', '端子电压', '现场反馈触点', '控制命令/反馈一致性'],
    actions: ['核对现场状态和PLC状态', '检查端子和线缆', '检查辅助触点', '必要时更换PLC模块'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:rotor-blade-imbalance-damage',
    label: '叶片不平衡、结冰或结构损伤引发载荷异常',
    system: '叶轮系统',
    component: '叶片/轮毂/桨距校准',
    summary: '叶片结冰、污染、结构损伤或桨距校准偏差会造成质量/气动不平衡，表现为 1P/3P 振动、功率偏差和载荷升高。',
    keywords: ['叶片', '轮毂', '结冰', '不平衡', '振动', '桨距校准', '载荷', '裂纹'],
    causes: ['结冰或污损', '叶片损伤', '桨距角校准偏差', '轮毂部件松动', '质量不平衡'],
    symptoms: ['振动升高', '功率偏差', '载荷异常', '机舱合成振动超限'],
    signals: ['1P振动', '3P振动', '根部弯矩', '功率曲线偏差'],
    actions: ['检查叶片外观和结冰', '核对桨距零位', '分析振动频率', '检查轮毂连接件'],
    sources: ['source:gearbox-vibration-diagnosis', 'source:gearbox-scada-digital-twin', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:safety-chain-emergency-stop',
    label: '安全链或急停保护链断开',
    system: '安全链系统',
    component: '安全继电器/急停/保护开关',
    summary: '安全链串联多个急停、超速、振动、门禁和关键保护触点，任一节点断开都会触发安全停机，需要按链路逐点排查。',
    keywords: ['安全链', '急停', '安全继电器', '保护链', '超速', '停机按钮', '门限位', '安全回路'],
    causes: ['急停按下', '安全继电器异常', '保护开关断开', '线缆或端子故障', '真实超限保护'],
    symptoms: ['安全链断开', '紧急停机', '无法启动', '需现场复位'],
    signals: ['安全链电压', '急停状态', '保护开关反馈', '安全继电器状态'],
    actions: ['按安全链图纸逐点测量', '确认急停和门禁', '检查安全继电器', '确认真实保护源'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:main-shaft-bearing-lubrication-load',
    label: '主轴轴承润滑、载荷或密封失效',
    system: '传动系统',
    component: '主轴轴承/密封/润滑脂',
    summary: '主轴轴承承受叶轮低速大载荷，润滑污染、密封失效、装配偏差或长期湍流载荷会造成剥落、温升和低频振动异常。',
    keywords: ['主轴', '主轴承', '轴承', '润滑脂', '密封', '剥落', '磨损', '低频振动', 'BPFI', 'BPFO'],
    causes: ['润滑污染', '密封失效', '轴承剥落', '装配同轴度偏差', '湍流载荷'],
    symptoms: ['主轴振动升高', '轴承温度高', '异响', '油脂金属磨屑增多'],
    signals: ['低频振动', '轴承温度', '油脂颗粒', '内外圈缺陷频率'],
    actions: ['检查润滑脂和密封', '做振动频谱分析', '检查主轴轴承游隙和损伤', '建立一机一档趋势'],
    sources: ['source:gearbox-vibration-diagnosis', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:mechanical-brake-pressure-friction',
    label: '机械制动压力、摩擦片或反馈异常',
    system: '制动系统',
    component: '高速轴制动器/刹车泵/压力开关',
    summary: '制动器依赖液压压力、摩擦片间隙和反馈开关闭环；压力不足、摩擦片磨损或反馈异常会导致刹车不能可靠释放或保持。',
    keywords: ['制动', '刹车', '刹车泵', '制动器', '摩擦片', '压力开关', '高速轴', '刹车压力'],
    causes: ['刹车压力不足', '摩擦片磨损', '制动器未释放', '压力开关异常', '刹车泵故障'],
    symptoms: ['刹车不能释放', '刹车压力低', '制动反馈异常', '启动失败'],
    signals: ['制动压力', '制动器反馈', '摩擦片间隙', '泵电流'],
    actions: ['检查制动压力', '检查摩擦片和间隙', '核对制动器反馈', '检查刹车泵和压力开关'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:hydraulic-station-pump-accumulator-valve',
    label: '液压站泵源、蓄能器或阀组异常',
    system: '液压系统',
    component: '液压泵/蓄能器/电磁阀/滤芯',
    summary: '液压站为偏航、制动或变桨提供压力源，泵源能力下降、蓄能器预充不足、滤芯堵塞或阀组内泄会导致建压慢、频繁补压或压力保持失败。',
    keywords: ['液压站', '液压泵', '蓄能器', '滤芯', '电磁阀', '换向阀', '泄漏', '建压', '保压', '油位', '油温'],
    causes: ['液压泵效率下降', '蓄能器预充压力不足', '滤芯堵塞', '阀组内泄', '油位或油温异常'],
    symptoms: ['建压时间长', '频繁补压', '压力保持不住', '液压泵动作时间异常'],
    signals: ['系统压力', '泵启动频次', '泵电流', '油温油位', '滤芯压差'],
    actions: ['检查油位油温和滤芯', '测液压泵出口压力和电流', '测蓄能器预充压力', '检查阀组内泄'],
    sources: ['source:pitch-hydraulic-diagnosis', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:cooling-water-loop-flow-temperature',
    label: '水冷回路流量、压力或散热能力不足',
    system: '水冷系统',
    component: '水泵/换热器/冷却液/流量开关',
    summary: '变流器、发电机或其他热源依赖水冷回路带走热量，泵、换热器、流量开关、冷却液和管路异常会引起温度升高或流量压力告警。',
    keywords: ['水冷', '冷却液', '水泵', '换热器', '流量', '压力', '散热', '冷却系统', '水压'],
    causes: ['冷却液不足', '水泵异常', '换热器堵塞', '流量开关异常', '管路漏液'],
    symptoms: ['水冷压力低', '流量低', '变流器温度高', '冷却液温度高'],
    signals: ['冷却液压力', '流量开关', '进出口温差', '泵运行反馈'],
    actions: ['检查冷却液液位和泄漏', '检查水泵运行', '清理换热器', '核对流量和压力开关'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:lubrication-system-flow-grease-oil',
    label: '集中润滑或齿轮油润滑不足',
    system: '润滑系统',
    component: '润滑泵/分配器/油脂罐/滤芯',
    summary: '润滑系统负责齿轮箱、偏航轴承、变桨轴承和主轴等部位，油脂不足、分配器堵塞、滤芯压差或泵反馈异常会造成磨损风险上升。',
    keywords: ['润滑', '油脂', '润滑泵', '分配器', '滤芯', '油脂罐', '齿轮油', '压差', '油位'],
    causes: ['油脂不足', '润滑泵故障', '分配器堵塞', '滤芯压差大', '管路泄漏'],
    symptoms: ['润滑超时', '油位低', '压差报警', '轴承或齿轮温度升高'],
    signals: ['润滑泵反馈', '油位', '滤芯压差', '轴承温度趋势'],
    actions: ['检查油脂罐和油位', '检查润滑泵反馈', '检查分配器和管路', '更换滤芯并复测压差'],
    sources: ['source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:communication-network-loss',
    label: '机组通信网络或现场总线中断',
    system: '通信系统',
    component: 'CAN/Profibus/EtherCAT/光纤/交换机',
    summary: '主控、变桨、变流器、传感器和远程监控依赖通信网络，线缆、终端电阻、光纤、交换机或协议节点异常会导致状态丢失和控制闭环中断。',
    keywords: ['通信', '通讯', 'CAN', 'Profibus', 'EtherCAT', 'Modbus', '光纤', '交换机', '总线', '丢失', '超时'],
    causes: ['通信线缆断开', '终端电阻异常', '光纤链路异常', '从站掉线', '交换机或模块故障'],
    symptoms: ['通信中断', '节点丢失', '状态字超时', '远程无法连接'],
    signals: ['总线状态', '节点在线状态', '链路灯', '通信错误计数'],
    actions: ['检查通信线缆和接头', '检查终端电阻', '查看节点在线状态', '检查光纤和交换机'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:grid-transformer-protection',
    label: '电网、箱变或并网保护异常',
    system: '电网系统',
    component: '箱变/断路器/并网接触器/电能质量',
    summary: '外部电网波动、箱变温度油位、断路器接触器状态或并网保护配置异常，会触发电压、频率、接地、孤岛或并网失败类故障。',
    keywords: ['电网', '箱变', '变压器', '并网', '断路器', '接触器', '电压', '频率', '接地', '孤岛', '电能质量'],
    causes: ['电网电压频率越限', '箱变温度或油位异常', '断路器反馈异常', '并网接触器异常', '接地故障'],
    symptoms: ['并网失败', '电网故障', '箱变告警', '频繁脱网'],
    signals: ['三相电压电流', '频率', '断路器反馈', '箱变温度油位', '保护动作记录'],
    actions: ['核对电网电压频率', '检查箱变状态', '检查并网断路器和接触器反馈', '读取保护装置记录'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:sensor-measurement-chain-drift-fault',
    label: '传感器测量链路漂移、断线或干扰',
    system: '传感器系统',
    component: '温度/压力/转速/振动/风速风向传感器',
    summary: '传感器、供电、屏蔽接地、AI/DI通道或线缆异常会造成虚假高低值、跳变或与机械表不一致，需要用独立测量交叉验证。',
    keywords: ['传感器', '测量', '漂移', '断线', '短路', '跳变', 'AI', 'DI', '屏蔽', '接地', '风速仪', '风向仪', '压力传感器', '温度传感器'],
    causes: ['传感器损坏', '线缆断路短路', '屏蔽接地不良', '供电异常', '采集通道故障'],
    symptoms: ['测量值跳变', '显示异常', '与机械表不一致', '信号丢失'],
    signals: ['传感器供电', '回路电阻', 'AI通道值', '机械表比对', '屏蔽接地状态'],
    actions: ['用独立仪表比对', '检查供电和回路电阻', '倒换采集通道', '检查屏蔽接地和接插件'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:yaw-cable-twist-position-limit',
    label: '偏航扭缆、角度或位置限位异常',
    system: '偏航系统',
    component: '偏航编码器/扭缆开关/左右限位',
    summary: '偏航角度测量、扭缆保护和左右限位共同保证电缆不被过度扭转；编码器、凸轮、限位开关或方向反馈异常会导致偏航受限或保护动作。',
    keywords: ['偏航', '扭缆', '解缆', '角度', '编码器', '凸轮', '左右限位', '机舱位置', '位置传感器'],
    causes: ['偏航编码器异常', '凸轮位置偏差', '限位开关误动作', '电缆扭转过大', '方向反馈错误'],
    symptoms: ['偏航位置超限', '解缆保护', '偏航方向异常', '机舱位置不变'],
    signals: ['偏航角度', '左右限位状态', '扭缆圈数', '编码器脉冲'],
    actions: ['确认电缆垂直状态', '检查偏航编码器和凸轮', '检查左右限位开关', '核对偏航方向反馈'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:nacelle-tower-vibration-structural-load',
    label: '机舱、塔筒或基础结构振动载荷异常',
    system: '机舱与塔架系统',
    component: '机舱加速度传感器/塔筒/基础连接',
    summary: '叶轮不平衡、传动链异常、塔筒结构松动或传感器异常都会表现为机舱/塔筒振动超限，需要结合频率、风况和功率状态判断。',
    keywords: ['机舱振动', '塔筒振动', '加速度', '合成振动', '基础', '结构', '载荷', '振动超限'],
    causes: ['叶轮不平衡', '传动链冲击', '塔筒连接松动', '基础异常', '振动传感器异常'],
    symptoms: ['机舱振动超限', '塔筒摆动超限', '振动停机', '随风速变化明显'],
    signals: ['机舱加速度', '塔筒振动', '1P/3P频率', '风速功率状态'],
    actions: ['确认振动传感器状态', '分析振动频率', '检查叶片和传动链', '检查塔筒基础连接'],
    sources: ['source:gearbox-vibration-diagnosis', 'source:gearbox-scada-digital-twin', 'source:local-fault-index'],
  }),
  mechanism({
    id: 'mechanism:environment-lightning-grounding-surge',
    label: '雷击、浪涌或接地屏蔽异常',
    system: '电气保护系统',
    component: '防雷器/接地/屏蔽层/浪涌保护',
    summary: '雷击和浪涌会损坏传感器、通信、变流器和控制模块；接地或屏蔽不良会放大干扰，造成通信丢失、测量跳变和模块损坏。',
    keywords: ['雷击', '浪涌', '防雷', '接地', '屏蔽', '干扰', 'SPD', '避雷器', '电磁干扰'],
    causes: ['雷击浪涌', '接地电阻异常', '屏蔽层接地不良', '防雷器失效', '电磁干扰'],
    symptoms: ['模块损坏', '通信异常', '信号跳变', '多系统同时报警'],
    signals: ['接地电阻', 'SPD状态', '屏蔽连续性', '故障发生天气记录'],
    actions: ['检查防雷器状态', '测接地电阻', '检查屏蔽层接地', '核对雷雨后多点故障记录'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
  mechanism({
    id: 'mechanism:scada-data-quality-alarm-correlation',
    label: 'SCADA数据质量、报警关联或工况边界异常',
    system: '主控系统',
    component: 'SCADA采集/报警逻辑/状态量',
    summary: '部分问题不是单一部件故障，而是报警阈值、状态量组合、工况边界和数据质量共同触发，需要把时间序列、伴随告警和现场状态对齐。',
    keywords: ['SCADA', 'HMI', '报警', '告警', '状态量', '趋势', '时间序列', '数据质量', '伴随告警', '阈值'],
    causes: ['报警阈值不匹配', '状态量组合异常', '数据采集丢点', '工况边界触发', '时间戳不一致'],
    symptoms: ['报警频繁出现', '现场无明显异常', '趋势跳变', '伴随多个状态码'],
    signals: ['报警时间线', 'SCADA趋势', 'HMI状态页', '伴随告警列表'],
    actions: ['导出报警前后趋势', '核对现场状态', '比对伴随告警', '确认阈值和状态量逻辑'],
    sources: ['source:local-fault-index', 'source:iec-61400-25'],
  }),
]

await main()

async function main() {
  const records = await readJsonl(FAULT_INDEX)
  const graph = buildGraph(records)
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(join(OUT_DIR, 'knowledge-graph.json'), `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  await writeFile(join(OUT_DIR, 'triples.jsonl'), renderTriples(graph.edges), 'utf8')
  await writeFile(join(OUT_DIR, 'nodes.csv'), renderCsv(graph.nodes, ['id', 'type', 'label', 'count', 'properties']), 'utf8')
  await writeFile(join(OUT_DIR, 'edges.csv'), renderCsv(graph.edges, ['id', 'source', 'target', 'type', 'weight', 'evidence', 'properties']), 'utf8')
  await writeFile(join(OUT_DIR, 'README.md'), renderReadme(graph), 'utf8')
  await writeFile(WIKI_FILE, renderWiki(graph), 'utf8')
  console.log(`Built fault-mechanism graph at ${OUT_DIR}`)
  console.log(`Nodes: ${graph.nodes.length}`)
  console.log(`Edges: ${graph.edges.length}`)
  console.log(`Matched fault records: ${graph.indexes.summary.matchedFaultRecords}`)
}

function buildGraph(records) {
  const nodes = new Map()
  const edges = new Map()

  for (const source of SOURCES) addNode(nodes, source)

  for (const mech of MECHANISMS) {
    addNode(nodes, {
      id: mech.id,
      type: 'mechanism',
      label: mech.label,
      aliases: [],
      count: 0,
      properties: {
        system: mech.system,
        component: mech.component,
        summary: mech.summary,
      },
    })
    addConceptBundle(nodes, edges, mech)
  }

  let matchedFaultRecords = 0
  const matchedByMechanism = new Map(MECHANISMS.map(mech => [mech.id, []]))

  for (const record of records.map(normalizeRecord).filter(Boolean)) {
    const matches = matchMechanisms(record)
    if (!matches.length) continue
    matchedFaultRecords += 1
    const faultNode = faultToNode(record)
    addNode(nodes, faultNode)
    for (const match of matches.slice(0, 3)) {
      addEdge(edges, faultNode.id, match.mechanism.id, 'EXPLAINED_BY_MECHANISM', match.score, [
        `code=${record.code}`,
        `source=${record.source}`,
        `matched=${match.hits.join(', ')}`,
      ])
      addEdge(edges, match.mechanism.id, 'source:local-fault-index', 'SUPPORTED_BY_SOURCE', 1, [record.source])
      matchedByMechanism.get(match.mechanism.id).push({ record, score: match.score, hits: match.hits })
    }
  }

  for (const [mechanismId, items] of matchedByMechanism.entries()) {
    const node = nodes.get(mechanismId)
    node.count = items.length
    node.properties.localFaultRecords = items.length
    node.properties.examples = items
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(item => ({
        code: item.record.code,
        name: item.record.name,
        site: item.record.site,
        model: item.record.model,
        score: item.score,
        source: item.record.source,
      }))
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.type.localeCompare(b.type) || b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'))
  const edgeList = [...edges.values()].sort((a, b) => a.type.localeCompare(b.type) || b.weight - a.weight)
  return {
    generatedAt: new Date().toISOString(),
    description: 'Fault-to-mechanism knowledge graph seeded from local wind turbine fault records and selected public technical references.',
    nodes: nodeList,
    edges: edgeList,
    indexes: {
      summary: {
        mechanisms: MECHANISMS.length,
        sources: SOURCES.length,
        localFaultRecords: records.length,
        matchedFaultRecords,
      },
      countsByNodeType: countBy(nodeList, node => node.type),
      countsByEdgeType: countBy(edgeList, edge => edge.type),
      mechanisms: MECHANISMS.map(mech => {
        const node = nodes.get(mech.id)
        return {
          id: mech.id,
          label: mech.label,
          system: mech.system,
          component: mech.component,
          localFaultRecords: node.count,
        }
      }).sort((a, b) => b.localFaultRecords - a.localFaultRecords),
      sources: SOURCES,
    },
  }
}

function addConceptBundle(nodes, edges, mech) {
  const systemId = conceptId('system', mech.system)
  const componentId = conceptId('component', mech.component)
  addNode(nodes, concept(systemId, 'system', mech.system))
  addNode(nodes, concept(componentId, 'component', mech.component))
  addEdge(edges, mech.id, systemId, 'BELONGS_TO_SYSTEM', 1, [mech.system])
  addEdge(edges, mech.id, componentId, 'INVOLVES_COMPONENT', 1, [mech.component])

  for (const cause of mech.causes) {
    const id = conceptId('causal_factor', cause)
    addNode(nodes, concept(id, 'causal_factor', cause))
    addEdge(edges, id, mech.id, 'CAN_TRIGGER', 1, [mech.label])
  }
  for (const symptom of mech.symptoms) {
    const id = conceptId('symptom', symptom)
    addNode(nodes, concept(id, 'symptom', symptom))
    addEdge(edges, mech.id, id, 'MANIFESTS_AS', 1, [mech.label])
  }
  for (const signal of mech.signals) {
    const id = conceptId('diagnostic_signal', signal)
    addNode(nodes, concept(id, 'diagnostic_signal', signal))
    addEdge(edges, mech.id, id, 'DIAGNOSED_BY', 1, [mech.label])
  }
  for (const action of mech.actions) {
    const id = conceptId('mitigation', action)
    addNode(nodes, concept(id, 'mitigation', action))
    addEdge(edges, mech.id, id, 'MITIGATED_BY', 1, [mech.label])
  }
  for (const question of defaultQuestionPatterns(mech)) {
    const id = conceptId('question_pattern', question)
    addNode(nodes, {
      id,
      type: 'question_pattern',
      label: question,
      aliases: mech.keywords.slice(0, 8),
      count: 0,
      properties: {
        system: mech.system,
        component: mech.component,
        mechanism: mech.label,
      },
    })
    addEdge(edges, id, mech.id, 'ROUTES_TO_MECHANISM', 1, [mech.label])
  }
  for (const sourceId of mech.sources) {
    addEdge(edges, mech.id, sourceId, 'SUPPORTED_BY_SOURCE', 1, [mech.summary])
  }
}

function defaultQuestionPatterns(mech) {
  const patterns = [
    `${mech.system}报警下一步查什么`,
    `${mech.component}故障怎么处理`,
    `${mech.label}怎么验证`,
  ]
  for (const symptom of mech.symptoms.slice(0, 2)) {
    patterns.push(`${symptom}怎么办`)
  }
  for (const signal of mech.signals.slice(0, 1)) {
    patterns.push(`${signal}异常怎么判断`)
  }
  return unique(patterns.map(clean)).slice(0, 6)
}

function matchMechanisms(record) {
  const haystack = normalizeForMatch([
    record.code,
    record.name,
    record.site,
    record.brand,
    record.model,
    record.reason,
    record.solution,
    record.logic,
    record.text,
    record.category,
  ].filter(Boolean).join(' '))

  return MECHANISMS.map(mech => {
    const hits = []
    let score = 0
    for (const rawKeyword of mech.keywords) {
      const keyword = normalizeForMatch(rawKeyword)
      if (!keyword) continue
      if (haystack.includes(keyword)) {
        hits.push(rawKeyword)
        score += Math.max(1, Math.min(4, keyword.length / 2))
      }
    }
    if (record.name && normalizeForMatch(record.name).includes(normalizeForMatch(mech.component))) score += 4
    if (record.reason && normalizeForMatch(record.reason).includes(normalizeForMatch(mech.component))) score += 3
    return { mechanism: mech, score: Number(score.toFixed(2)), hits }
  })
    .filter(item => item.score >= 2.5 && item.hits.length >= 1)
    .sort((a, b) => b.score - a.score)
}

function mechanism(input) {
  return input
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null
  const code = clean(raw.code)
  const source = clean(raw.source)
  if (!code || !source) return null
  return {
    code,
    name: clean(raw.name),
    site: clean(raw.site),
    brand: clean(raw.brand),
    model: clean(raw.model),
    reason: clean(raw.reason),
    solution: clean(raw.solution),
    logic: clean(raw.logic),
    category: clean(raw.category),
    source,
    text: clean(raw.text),
  }
}

function faultToNode(record) {
  const label = record.name ? `${record.code} ${record.name}` : record.code
  return {
    id: `fault_record:${hash(`${record.code}|${record.source}`)}`,
    type: 'fault_record',
    label,
    aliases: [record.code, record.name].filter(Boolean),
    count: 1,
    properties: {
      code: record.code,
      name: record.name,
      site: record.site,
      brand: record.brand,
      model: record.model,
      reason: record.reason,
      solution: record.solution,
      logic: record.logic,
      category: record.category,
      source: record.source,
    },
  }
}

function addNode(nodes, node) {
  const existing = nodes.get(node.id)
  if (existing) {
    existing.count += node.count ?? 1
    return existing
  }
  const normalized = {
    id: node.id,
    type: node.type,
    label: node.label,
    aliases: node.aliases ?? [],
    count: node.count ?? 1,
    properties: node.properties ?? {
      url: node.url,
      note: node.note,
    },
  }
  nodes.set(normalized.id, normalized)
  return normalized
}

function addEdge(edges, source, target, type, weight, evidence = []) {
  const id = `${source}->${type}->${target}`
  const existing = edges.get(id)
  if (existing) {
    existing.weight += weight
    existing.evidence.push(...evidence)
    existing.evidence = unique(existing.evidence).slice(0, 20)
    return existing
  }
  const edge = {
    id,
    source,
    target,
    type,
    weight,
    evidence: unique(evidence).slice(0, 20),
    properties: {
      evidence: evidence[0] ?? '',
    },
  }
  edges.set(edge.id, edge)
  return edge
}

function concept(id, type, label) {
  return { id, type, label, aliases: [], count: 0, properties: {} }
}

function conceptId(type, label) {
  return `${type}:${hash(label)}`
}

function hash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12)
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeForMatch(value) {
  return clean(value).toLowerCase().replace(/\s+/g, '')
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

async function readJsonl(filePath) {
  const text = await readFile(filePath, 'utf8')
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    rows.push(JSON.parse(trimmed))
  }
  return rows
}

function countBy(items, keyer) {
  const counts = {}
  for (const item of items) counts[keyer(item)] = (counts[keyer(item)] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]))
}

function renderTriples(edges) {
  return `${edges.map(edge => JSON.stringify(edge)).join('\n')}\n`
}

function renderCsv(rows, columns) {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map(column => csvCell(row[column])).join(','))
  }
  return `${lines.join('\n')}\n`
}

function csvCell(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  return `"${text.replaceAll('"', '""')}"`
}

function renderReadme(graph) {
  return `# 故障-机理知识图谱

这是从本地风机故障码资料和公开技术资料建立的第一版故障机理子图。

## 文件

- \`knowledge-graph.json\`：节点、关系、统计索引。
- \`triples.jsonl\`：逐行关系记录。
- \`nodes.csv\` / \`edges.csv\`：便于导入表格或图数据库。

## 当前规模

- 机理模板：${graph.indexes.summary.mechanisms}
- 来源：${graph.indexes.summary.sources}
- 本地故障记录：${graph.indexes.summary.localFaultRecords}
- 已挂接故障记录：${graph.indexes.summary.matchedFaultRecords}
- 节点：${graph.nodes.length}
- 关系：${graph.edges.length}

## 主要关系

- \`fault_record -> EXPLAINED_BY_MECHANISM -> mechanism\`
- \`causal_factor -> CAN_TRIGGER -> mechanism\`
- \`mechanism -> MANIFESTS_AS -> symptom\`
- \`mechanism -> DIAGNOSED_BY -> diagnostic_signal\`
- \`mechanism -> MITIGATED_BY -> mitigation\`
- \`question_pattern -> ROUTES_TO_MECHANISM -> mechanism\`
- \`mechanism -> SUPPORTED_BY_SOURCE -> source\`

## 外部来源

${SOURCES.filter(source => source.id !== 'source:local-fault-index').map(source => `- [${source.label}](${source.url})：${source.note}`).join('\n')}
`
}

function renderWiki(graph) {
  const mechanisms = graph.indexes.mechanisms
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]))
  return `# 故障与机理知识图谱

本页是 \`graph/fault-mechanism/knowledge-graph.json\` 的人工可读摘要。第一版重点把本地故障码和通用机理建立映射，适合后续审校、补充和可视化。

## 规模

- 机理模板：${graph.indexes.summary.mechanisms}
- 已挂接本地故障记录：${graph.indexes.summary.matchedFaultRecords}
- 节点：${graph.nodes.length}
- 关系：${graph.edges.length}

## 机理覆盖

| 机理 | 系统 | 部件 | 本地故障记录 |
| --- | --- | --- | ---: |
${mechanisms.map(item => `| ${item.label} | ${item.system} | ${item.component} | ${item.localFaultRecords} |`).join('\n')}

## 机理条目

${mechanisms.map(item => renderMechanismSection(item, nodeById)).join('\n\n')}

## 建模边界

- 本地图谱证据来自 \`wind-llmwiki/fault-index.jsonl\`。
- 外部资料只用于建立通用机理框架，不直接替代厂家手册处理步骤。
- 当前匹配是关键词规则，适合做第一版候选关系；关键故障需要人工复核后再作为高置信关系。

## 外部参考

${SOURCES.filter(source => source.id !== 'source:local-fault-index').map(source => `- [${source.label}](${source.url})`).join('\n')}
`
}

function renderMechanismSection(item, nodeById) {
  const mechanism = MECHANISMS.find(entry => entry.id === item.id)
  const node = nodeById.get(item.id)
  const examples = node?.properties?.examples ?? []
  return `### ${item.label}

- 系统：${item.system}
- 部件：${item.component}
- 机理：${mechanism?.summary ?? ''}
- 常见触发因素：${(mechanism?.causes ?? []).join('；')}
- 典型表现：${(mechanism?.symptoms ?? []).join('；')}
- 诊断信号：${(mechanism?.signals ?? []).join('；')}
- 检查处理：${(mechanism?.actions ?? []).join('；')}
- 常见问法：${defaultQuestionPatterns(mechanism ?? { system: item.system, component: item.component, label: item.label, symptoms: [], signals: [], keywords: [] }).join('；')}
- 本地候选故障记录：${item.localFaultRecords}

${examples.length ? `典型本地故障：

| 故障码 | 名称 | 风场 | 机型 | 来源 |
| --- | --- | --- | --- | --- |
${examples.slice(0, 8).map(example => `| ${example.code} | ${example.name || ''} | ${example.site || ''} | ${example.model || ''} | ${example.source || ''} |`).join('\n')}` : '典型本地故障：暂无。'}`
}
