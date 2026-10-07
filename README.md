# 串联 RLC 阻抗扫频与半功率点核验后端

纯本地离线运行的串联 RLC 频率分析服务：TypeScript + Node.js + SQLite（better-sqlite3），只提供 HTTP API 与 CLI，无任何前端、Docker、外部在线服务。

## 模型与口径约定

- **电路**：单条理想串联支路 R–L–C，接正弦电源。不解析网表、不做直流求解 / 潮流 / 时域仿真 / 参数拟合，不连接真实仪器。
- **单位**：R 欧姆、L 亨利、C 法拉、V 伏特（**有效值 RMS**）、f 赫兹。所有功率均按有效值口径计算，不乘除 2 混入峰值。
- **阻抗**：`ω = 2πf`，`XL = ωL`，`XC = -1/(ωC)`（负号不省略），`Z = R + j(ωL - 1/(ωC))`。
- **相量**：电源相位固定为 0，`I = V/Z`；`VR = I·R`，`VL = I·jωL`，`VC = I·(-j/(ωC))`。三者**复数相加**等于电源相量（每点返回 `kvlResidual` 供核验）；电压的模不能直接相加。谐振时 VL、VC 各自非零但相互抵消。
- **功率**：有功 `P = |I|²·R`；无功 `Q = |I|²·X`，符号与总电抗 X 一致（容性为负、感性为正）；视在 `S = V·|I|`。
- **相位**：单位为度，固定半开区间 `(-180, 180]`。模为零的相量相位未定义，输出 `null`（零电源时电流/各电压相位为 `null`，但阻抗相位仍有效）。
- **浮点核验容差**：相对容差 `1e-9`（见 `src/core/rlc.ts` 的 `TOL_REL`）。

## 特征频率（全部来自解析公式，非离散采样）

- `ω0 = 1/√(LC)`，`f0 = ω0/(2π)`，`Q = ω0L/R`，谐振电流 `I0 = V/R`（也是扫频电流最大值）。
- 半功率点（电阻功率 = 谐振功率一半的两个正频率）：令 `s = √(R² + 4L/C)`，
  `ωLow = 2/(C·(s+R))`，`ωHigh = (s+R)/(2L)`，换算为赫兹；带宽 `BW = R/(2πL)`，并附 `fHigh - fLow` 交叉核验。
- 零电源时特征频率仍由电路决定并正常给出，但不构造 0/0 的"实测功率比"。
- 扫频报告另附**采样峰值**（离散网格上电流最大点）及网格步长，明确标注它不是精确谐振点。

## 参数校验与错误码

- R、L、C、f 必须为正有限数（拒绝 R=0 / L=0 / C=0，不用极小值替代）；V 可为 0 但不为负。
- 上限：R≤1e12、L≤1e6、C≤1e3、V≤1e9、f≤1e12，单次扫频 ≤10000 点。
- 中间量出现 NaN/∞ 报 `NON_FINITE_RESULT`，不会写成成功结果。
- 错误码：`INVALID_PARAM`、`OUT_OF_RANGE`、`NON_FINITE_RESULT`、`NOT_FOUND`、`BAD_REQUEST`、`CONFLICT`，响应体为 `{ "error": { code, message, details } }`。

## 持久化与幂等

- SQLite 数据库位于项目内 `data/rlc.sqlite`（可用环境变量 `RLC_DATA_DIR` 覆盖）。
- 电路保存参数、单位、算法版本（`rlc-series-ideal/1.0.0`）；报告与逐点结果在同一事务中原子写入，非法批次不会留下貌似完整的曲线。
- 请求体可带 `clientRequestId`，重复提交幂等返回已有记录。
- 报告保存冻结参数快照：修改元件或频率范围会生成新电路/新报告，旧报告重启后仍按原参数读取，无需重算。

## 构建、测试、启动、演示

```powershell
npm install        # 安装依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API 服务（默认自动选择空闲端口，PORT=8080 可指定）
npm run demo       # 内置演示：R=10, L=0.1, C=0.001, V=10
```

演示电路核验值：`ω0 = 100 rad/s`，`f0 ≈ 15.9155 Hz`，谐振电流 1 A，电阻功率 10 W，`VL = +j10 V`，`VC = -j10 V`；半功率点电流模 `1/√2 A`，相位分别 `+45°` / `-45°`，带宽 `≈15.9155 Hz`。

## CLI 用法

```
node dist/src/cli.js serve [--port N]
node dist/src/cli.js new --r 10 --l 0.1 --c 0.001 --v 10 [--name demo] [--req ID]
node dist/src/cli.js list
node dist/src/cli.js point --circuit 1 --f 15.91549431
node dist/src/cli.js sweep --circuit 1 --mode log --start 1 --end 1000 --count 11
node dist/src/cli.js sweep --circuit 1 --mode linear --start 1 --end 100 --count 20
node dist/src/cli.js sweep --circuit 1 --mode list --freqs 5,15.9155,50
node dist/src/cli.js report --id 2
node dist/src/cli.js characteristics --circuit 1
node dist/src/cli.js compare --a 1 --b 2
node dist/src/cli.js export --id 2 --format csv
node dist/src/cli.js demo
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/circuits` | 保存电路 `{r,l,c,v,name?,clientRequestId?}` |
| GET | `/circuits` / `/circuits/:id` | 列表 / 详情 |
| POST | `/circuits/:id/point` | 单点计算 `{f, clientRequestId?}` |
| POST | `/circuits/:id/sweeps` | 扫频 `{mode:list\|linear\|log, ...}` |
| GET | `/circuits/:id/characteristics` | 解析特征频率 |
| GET | `/circuits/:id/reports` | 该电路的报告列表 |
| GET | `/reports/:id` | 报告全文（逐点相量与功率） |
| GET | `/reports/:id/export?format=json\|csv` | 导出 |
| GET | `/compare?a=1&b=2` | 比较两个参数版本 |

每个扫频点保存：频率、阻抗分量（R、XL、XC、Z 相量）、电流相量、VR/VL/VC 相量、KVL 残差、P/Q/S，即完整的计算依据。

## 测试

`test/rlc.test.ts` 与 `test/db.test.ts` 覆盖：相量闭合（KVL）、功率账目（P/Q/S 与符号）、带宽与半功率点（独立标量公式核对）、静态零电源、单位/符号约定（XC 负号、容性感性区）、网格端点精确包含与列表顺序、参数校验、幂等、原子性与重启后可读。共 16 个用例。

## 限制

- 仅理想单支路串联 RLC；不含寄生参数、源内阻、非线性。
- 不处理任意极端尺度（见参数上限）；超出可计算数值范围时报 `NON_FINITE_RESULT`。
- API 监听 `127.0.0.1`，无鉴权，仅面向本机离线核验用途。
