# 串联 RLC 阻抗扫频与半功率点核验后端

本项目是一个**纯本地、离线**运行的理想串联 RLC 电路频率分析后端，只提供 HTTP API 与命令行（CLI），无前端。技术栈：TypeScript + Node.js + SQLite（使用 Node 内置 `node:sqlite`，**零运行时依赖**，不需要 Docker / WSL / 外部服务）。

## 模型与约定

- 电路只有一条串联支路：电阻 R、电感 L、电容 C 与正弦电压源串联。不解析网表、不做直流求解、潮流、时域仿真或参数拟合，也不连接任何真实仪器。
- 输入单位统一为：欧姆（Ω）、亨利（H）、法拉（F）、伏特有效值（V rms）、赫兹（Hz）。
- 角频率 `omega = 2*pi*f`；电感电抗 `XL = omega*L`；电容电抗 `XC = -1/(omega*C)`（**负号不省略**）。
- 总阻抗 `Z = R + j*(omega*L - 1/(omega*C))`；电源相位固定为 0，电流相量 `I = V / Z`。
- 元件电压相量：`VR = I*R`，`VL = I*j*omega*L`，`VC = I*(-j/(omega*C))`。三者**复数相加**等于电源相量（每个计算点都带 KVL 核验误差）；电压的**模不能直接相加**。
- 全部相量使用**有效值（RMS）口径**，不乘 2 也不除 2，不混入峰值。
- 有功功率 `P = |I|^2 * R`；无功功率 `Q = |I|^2 * X`，**符号与总电抗 X 一致**（感性为正、容性为负）；视在功率 `S = V * |I|`。每个点同时核验 `V*conj(I) == P + jQ`。
- 相位统一为度，半开区间 `(-180, 180]`；相量模为零时相位无定义，输出 `null`（零电源时电流与各元件电压相位为 `null`，但阻抗相位仍有效）。
- 浮点核验容差：`tol = 1e-12 + 1e-9 * 参考量级`（见 `src/rlc.ts` 中 `TOL_ABS` / `TOL_REL`），每个点的 `checks` 字段给出实际误差与是否通过。

## 谐振与半功率点（解析解，非采样峰值）

- `omega0 = 1/sqrt(L*C)`，`f0 = omega0/(2*pi)`，`Q = omega0*L/R`，谐振电流有效值 `V/R`。
- 半功率点 = 电阻功率降为谐振功率一半的两个正频率。令 `s = sqrt(R^2 + 4L/C)`：
  `omegaLow = 2/(C*(s+R))`，`omegaHigh = (s+R)/(2*L)`，带宽 `BW = R/(2*pi*L)`。
- 摘要中的谐振/半功率数据全部来自上述解析关系；扫频另报 `sampledPeak`（离散网格上的最大电流点及其频率分辨率），它**不是**精确谐振点。
- 零电源（V=0）时仍给出由 L、C、R 决定的特征频率，但 `halfPowerCurrentRms` 为 `null`（不存在可测功率比，不做 0/0）。

## 参数校验与限制

- R、L、C、频率必须为正的有限数；拒绝 `R=0`、`L=0`、`C=0`（超出本题理想模型），不用极小值顶替。
- 电源有效值 V 允许为 0，不允许负数。
- 参数范围 `[1e-12, 1e12]`，频率范围 `[1e-12, 1e12] Hz`，单次扫频最多 10000 点；出现非有限中间量时报 `RANGE_ERROR`，不会把 NaN/Infinity 写成成功结果。本工具不面向任意极端尺度。
- 错误码：`VALIDATION_ERROR`（400）、`RANGE_ERROR`（422）、`NOT_FOUND`（404）、`BAD_REQUEST`（400）、`INTERNAL_ERROR`（500）。

## 持久化与幂等

- SQLite 数据库默认在项目内 `data/rlc.db`（可用 `--db` 或 API 启动参数更换）。
- 每次保存参数生成一个**冻结的电路版本**（含参数、单位、算法版本 `rlc-1.0.0`）；修改元件或频率范围会产生新版本/新报告，旧扫频报告仍引用旧版本参数，重启后可直接读取，无需重算。
- 扫频提交支持 `idempotencyKey`：相同键重复提交返回原报告（`idempotentReplay: true`），不会重复写入。
- 整个扫频批次在单个事务中原子写入；非法批次不会留下貌似完整的曲线。

## 构建、测试、启动、演示

```powershell
npm install      # 仅安装 typescript / @types/node（开发依赖）
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试（node:test）
npm start        # 启动 API（默认自动选择空闲端口，打印实际端口）
npm run demo     # 运行 R=10, L=0.1, C=0.001, V=10 演示
```

指定端口：`node dist/src/cli.js serve --port 8080`

## CLI 用法

```
node dist/src/cli.js save-circuit --r 10 --l 0.1 --c 0.001 --v 10 --name demo
node dist/src/cli.js point --version 1 --f 15.9155
node dist/src/cli.js sweep --version 1 --mode linear --start 1 --end 100 --count 50 --key my-sweep-1
node dist/src/cli.js sweep --version 1 --mode log --start 1 --end 100 --count 9
node dist/src/cli.js sweep --version 1 --mode list --freqs "5,15.9155,30"
node dist/src/cli.js sweep-show --sweep 1
node dist/src/cli.js characteristics --version 1
node dist/src/cli.js new-version --circuit 1 --r 20 --l 0.1 --c 0.001 --v 10
node dist/src/cli.js versions --circuit 1
node dist/src/cli.js compare --a 1 --b 2
node dist/src/cli.js export --sweep 1 --format csv
node dist/src/cli.js list
```

## HTTP API

所有端点以 `/api` 为前缀，请求与响应均为 JSON（导出支持 CSV）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/circuits` | 保存电路 `{r,l,c,v,name?}`，返回 `circuitId` 与版本 `id` |
| POST | `/api/circuits/:circuitId/versions` | 修改参数，生成新的冻结版本 |
| GET | `/api/circuits` | 列出电路 |
| GET | `/api/circuits/:circuitId/versions` | 列出版本 |
| GET | `/api/versions/:versionId` | 查看版本参数、单位、算法版本 |
| POST | `/api/versions/:versionId/point` | 单点计算 `{f}` |
| POST | `/api/versions/:versionId/sweeps` | 提交扫频 `{mode, freqs?|start,end,count, idempotencyKey?}` |
| GET | `/api/versions/:versionId/sweeps` | 列出该版本扫频 |
| GET | `/api/versions/:versionId/characteristics` | 谐振/半功率解析摘要 |
| GET | `/api/sweeps/:sweepId` | 读取扫频结果（含每点相量、功率、核验） |
| GET | `/api/sweeps/:sweepId/export?format=json\|csv` | 导出 |
| GET | `/api/compare?a=VID&b=VID` | 比较两个参数版本 |

示例：

```powershell
# 保存电路
curl -X POST http://127.0.0.1:PORT/api/circuits -H "content-type: application/json" -d '{\"r\":10,\"l\":0.1,\"c\":0.001,\"v\":10}'
# 提交对数扫频（幂等）
curl -X POST http://127.0.0.1:PORT/api/versions/1/sweeps -H "content-type: application/json" -d '{\"mode\":\"log\",\"start\":1,\"end\":100,\"count\":9,\"idempotencyKey\":\"s1\"}'
```

## 演示核验值（R=10, L=0.1, C=0.001, V=10）

- `omega0 = 100 rad/s`，`f0 ≈ 15.9155 Hz`，`Q = 1`。
- 谐振电流 1 A（有效值），电阻功率 10 W；`VL = +j10 V`，`VC = -j10 V`（相互抵消但各自非零）。
- 半功率点电流模 `1/sqrt(2) ≈ 0.7071 A`，两点电流相位分别为 `+45°`（容性侧）与 `-45°`（感性侧），带宽 `R/(2*pi*L) ≈ 15.9155 Hz`。

## 测试

`npm test` 覆盖：相量闭合（KVL）、功率账目（`V*conj(I) = P + jQ`）、带宽与半功率点、零电源静态行为、非法输入（R=0/L=0/C=0/非有限值/非法频率）、网格端点包含与列表顺序、相位区间约定、扫频持久化/幂等/冻结版本/重启读取、HTTP API 端到端。数值均用独立标量公式核对。

## 目录结构

```
src/complex.ts   复数运算与相位约定
src/rlc.ts       RLC 核心：单点计算、特征频率、校验、容差
src/grid.ts      扫频网格（list/linear/log）与采样峰值
src/db.ts        SQLite 持久化（事务、幂等、冻结版本、CSV 导出）
src/server.ts    HTTP API
src/cli.ts       命令行
test/            node:test 测试
data/            默认数据目录（rlc.db）
```

## 已知限制

- 仅理想串联 RLC 单支路稳态频域分析；不含元件寄生参数、初始暂态与非线性。
- 参数/频率限制在 `[1e-12, 1e12]` 量级内，不处理任意极端尺度。
- API 仅监听 `127.0.0.1`，无鉴权，面向本机离线使用。
