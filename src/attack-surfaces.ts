/**
 * 题型攻击面宇宙(第 6 层 L3 的"分母")。
 * 判不可行 = 覆盖饱和: 死路清单(已试) ÷ 本题型攻击面宇宙(该试的)。
 * 纯逻辑 L0 可测; 清单是领域先验(pentest 方法论), 宿主可扩展。
 * @module @shence/jisi/attack-surfaces
 */

import type { QuestionType } from './model-ledger-v2.ts'

/** 攻击面条目: 名称 + 关键字(用于把死路/观察自动归入对应面)。 */
export interface AttackSurface {
  id: string
  name: string
  keywords: string[]
}

export const ATTACK_SURFACES: Record<QuestionType, AttackSurface[]> = {
  web: [
    { id: 'recon', name: '侦察/指纹', keywords: ['recon', '指纹', 'banner', '目录', 'dirsearch', 'robots'] },
    { id: 'authn', name: '认证', keywords: ['login', '认证', 'password', '密码', 'jwt', 'session', 'cookie', 'captcha', 'otp'] },
    { id: 'sqli', name: 'SQL 注入', keywords: ['sqli', 'sql injection', '注入', "select '", 'union'] },
    { id: 'xss', name: 'XSS', keywords: ['xss', 'script', '跨站'] },
    { id: 'ssrf', name: 'SSRF', keywords: ['ssrf', 'url=', 'proxy', 'fetch url'] },
    { id: 'idor', name: 'IDOR/越权', keywords: ['idor', '越权', 'id=', 'uuid', '水平权限'] },
    { id: 'lfi', name: '文件包含/读取', keywords: ['lfi', 'rfi', 'file=', 'include', 'path traversal', '目录穿越', 'file://'] },
    { id: 'upload', name: '文件上传', keywords: ['upload', '上传', 'multipart'] },
    { id: 'rce', name: '命令/代码执行', keywords: ['rce', 'exec', 'command', '代码执行', '反序列化', 'deserial', 'pickle', 'eval'] },
    { id: 'ssrf-intra', name: '内网横向', keywords: ['内网', '横向', 'ssrf 内网', 'intranet', 'redis', '代理'] },
    { id: 'crypto-weak', name: '弱加密/弱密钥', keywords: ['弱密钥', '硬编码', 'key leak', 'weak crypto'] },
    { id: 'logic', name: '业务逻辑', keywords: ['逻辑', '越权逻辑', 'race', '条件竞争', '折扣'] },
  ],
  crypto: [
    { id: 'weak-param', name: '弱参数', keywords: ['n 小', 'e=3', '共模', '小公钥', 'factor', 'yafu'] },
    { id: 'congruence', name: '同余/CRT', keywords: ['crt', '同余', 'chinese remainder'] },
    { id: 'lattice', name: '格攻击', keywords: ['lattice', '格', 'lll', 'coppersmith', 'hidden number'] },
    { id: 'algebra', name: '代数结构', keywords: ['groebner', '多项式', '有限域', 'galois'] },
    { id: 'padding', name: 'Padding 预言机', keywords: ['padding oracle', 'bleichenbacher', 'pkcs'] },
    { id: 'reuse', name: '密钥/随机数重用', keywords: ['nonce reuse', '随机数', 'stream', '同一密钥'] },
    { id: 'side', name: '侧信道/泄露', keywords: ['泄露', 'oracle', 'crc', '噪声', '候选值', 'timing'] },
    { id: 'impl', name: '实现缺陷', keywords: ['实现', '轮数', '自实现', '自定义'] },
  ],
  pwn: [
    { id: 'overflow', name: '栈溢出', keywords: ['overflow', '栈', 'ret2', 'rop', 'buffer'] },
    { id: 'heap', name: '堆利用', keywords: ['heap', '堆', 'tcache', 'uaf', 'double free'] },
    { id: 'fmt', name: '格式化字符串', keywords: ['fmt', 'format string', '格式化'] },
    { id: 'logic-bug', name: '逻辑漏洞', keywords: ['逻辑', 'integer', '越界', 'off-by-one'] },
    { id: 'env', name: '环境绕过', keywords: ['canary', 'pie', 'aslr', 'nx', 'seccomp', '沙箱'] },
  ],
  rev: [
    { id: 'static', name: '静态分析', keywords: ['ida', 'ghidra', '反编译', 'disassemble', 'strings'] },
    { id: 'dynamic', name: '动态调试', keywords: ['gdb', '调试', '断点', 'trace'] },
    { id: 'crypto-inner', name: '内置算法还原', keywords: ['算法', '密钥调度', '还原', 'check', '校验'] },
    { id: 'vm', name: 'VM/解释器', keywords: ['vm', '解释器', 'opcode', '虚拟机'] },
  ],
  forensics: [
    { id: 'fs', name: '文件系统/磁盘', keywords: ['磁盘', '镜像', 'filesystem', 'mft'] },
    { id: 'net', name: '流量分析', keywords: ['pcap', '流量', 'wireshark', '协议'] },
    { id: 'mem', name: '内存取证', keywords: ['内存', 'volatility', 'dump'] },
    { id: 'artifact', name: '工件解析', keywords: ['日志', '浏览器', '注册表', 'artifact', '时间线'] },
    { id: 'stego', name: '隐写', keywords: ['stego', '隐写', 'lsb', 'metadata', 'exif'] },
  ],
  misc: [
    { id: 'generic', name: '通用线索', keywords: ['线索', '提示', '编码', 'base64', 'hex'] },
    { id: 'guess', name: '密码学杂项', keywords: ['密码', '加密', '解密'] },
  ],
}

export interface CoverageResult {
  qtype: QuestionType
  total: number
  covered: number
  uncovered: string[]
  /** 覆盖比 0-1。 */
  ratio: number
}

/**
 * 用死路/观察文本做关键词归入攻击面, 计算覆盖。
 * text 来源: 知识账本的 dead-end/observation 条目(path+conclusion)。
 */
export function coverageOf(qtype: QuestionType, triedTexts: string[]): CoverageResult {
  const surfaces = ATTACK_SURFACES[qtype] ?? []
  const covered = new Set<string>()
  for (const text of triedTexts) {
    const low = text.toLowerCase()
    for (const s of surfaces) {
      if (s.keywords.some(k => low.includes(k))) covered.add(s.id)
    }
  }
  const uncovered = surfaces.filter(s => !covered.has(s.id)).map(s => `${s.id}(${s.name})`)
  return {
    qtype,
    total: surfaces.length,
    covered: covered.size,
    uncovered,
    ratio: surfaces.length === 0 ? 1 : covered.size / surfaces.length,
  }
}
