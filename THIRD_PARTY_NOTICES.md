# 第三方组件与参考实现声明

本声明仅适用于下列第三方组件及参考实现，不改变本项目其他代码的许可。TraceMemo 的闭源 DLL 已不再作为新版构建输入；保留其名称作为历史说明不构成复用授权。

## 工作台图表：Recharts 3.10.1（0.7.0）

- 新增图表组件固定为 Recharts 3.10.1，主体采用 MIT；[固定版本许可证](https://github.com/recharts/recharts/blob/v3.10.1/LICENSE)。
- 构建前 `scripts/chart-license-prepare.cjs` 离线核对固定来源，并准备 `native-resources/chart-licenses`；发行时作为独立资源随包提供。
- 通知集合保留 44 个已安装依赖/共享包的 58 份原始许可及 NOTICE，包含 MIT、ISC、BSD 声明和 es-toolkit NOTICE；集合是保守范围，不表示所有类型包进入运行时。
- victory-vendor 包装层缺失的 MIT 取自官方固定版本 [v37.3.6](https://raw.githubusercontent.com/FormidableLabs/victory/v37.3.6/LICENSE.txt)，本地来源固定后不依赖联网构建。各供应商许可另外保留。
- `chart-licenses/manifest.json` 列出包版本、相对来源和文件摘要，不包含客户资料或本机绝对路径。本轮参考十款产品的设计机制，但未引入它们的应用源代码。

## SQLite3 Multiple Ciphers 2.5.1

- 作者声明：Copyright (c) 2019-2026 Ulrich Telle；MIT License。
- [官方版本及资源](https://github.com/utelle/SQLite3MultipleCiphers/releases/tag/v2.5.1)，[固定版本许可证](https://github.com/utelle/SQLite3MultipleCiphers/blob/v2.5.1/LICENSE)。
- [官方 Windows x64 ZIP（无 ICU）](https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.5.1/sqlite3mc-2.5.1-sqlite-3.53.4-win64.zip)：6,496,573 字节；SHA-256 `858c4f2e9e262caca06e6c4fafee62d13dd90c21b649b047f17992bf0402981e`。
- 只使用包内 `dll/sqlite3mc_x64.dll`（SQLite 3.53.4），重命名为 `wechat-reader/sqlite3mc.dll`：2,442,576 字节；SHA-256 `5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e`。
- 原始 MIT 许可证随 `wechat-reader/LICENSE` 分发；其 SHA-256 为 `54b6f21239a5eddb9f12bb47b91b9d36ea5a16e86b1c324a13bf943b875a7449`。不分发上游 shell EXE 或 ICU 组件。

## wcdb-key-tool 只读原理参考

- 作者声明：Copyright (c) 2025 CloudDreamAI / TANGandXUE；MIT License。
- [固定提交](https://github.com/TANGandXUE/wcdb-key-tool/tree/79f1b5b92e12c66aa281b4a60a3c478b5f547dfa)：`79f1b5b92e12c66aa281b4a60a3c478b5f547dfa`；[许可证](https://github.com/TANGandXUE/wcdb-key-tool/blob/79f1b5b92e12c66aa281b4a60a3c478b5f547dfa/LICENSE)。
- 参考 [Windows 实现](https://github.com/TANGandXUE/wcdb-key-tool/blob/79f1b5b92e12c66aa281b4a60a3c478b5f547dfa/wcdb_key_tool_windows.py) 中 `Config.Cipher` 运行时对象定位、候选片段解码及数据库第一页 HMAC 验证原理。对应本项目 `wechat-readonly-memory.ts` 和 `wechat-key-material.ts`。
- 本项目不运行上游工具，不引入调试器捕获、凭据文件缓存或数据库导出流程；不获取其他软件保存的凭据，不发送消息或写入微信数据库。只读仍需使用者对自己账号的授权及系统访问权限。
- 上游说明不等于本机验收：微信 4.1.9 的实际连接、消息与媒体读取结果分别记录在 `outputs` 中的版本验收报告，不将单次样本成功当作全部格式或后续微信版本兼容的证明。MIT 授权也不等于微信平台授权、无账号风险或永久兼容。
- 下列原始声明随 `wechat-reader/wcdb-key-tool-LICENSE` 分发并纳入 manifest 校验：1,080 字节；SHA-256 `c9e2f8dbaf8361e6bdb1b1952d38908f1265b775f0292a9d3c81d066d131c695`。换电脑构建时须同时带入该文件。

```text
MIT License

Copyright (c) 2025 CloudDreamAI / TANGandXUE

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Koffi 3.1.0

Koffi 作为现有 Node.js 原生桥接层保留，不属于被移除的 TraceMemo DLL。

- Copyright (C) 2026 Niels Martignène；MIT License；[官方项目](https://koffi.dev/)及锁定依赖内 `LICENSE.txt`。
- `koffi/win32_x64/koffi.node`：1,045,504 字节；SHA-256 `f83df5e836a3d7cdffff9ed2ae1300c2e67225892df94930775be533b21e619b`。
- 构建准备脚本随桥接文件保留 `koffi/LICENSE.txt`、`koffi/vendor/node-api-headers/LICENSE`（Copyright (c) 2021 Node.js）及 `koffi/vendor/node-addon-api/LICENSE.md`（Copyright (c) 2017 Node.js API collaborators），均为 MIT 声明。

## 微信 V2 图片格式参考（0.4.1）

- 参考 [wechatauto-replica 的固定提交](https://github.com/fanyuantaier/wechatauto-replica/tree/22ee7adf875414da5bb8984860565930ecb31d7a) 中 [media.py](https://github.com/fanyuantaier/wechatauto-replica/blob/22ee7adf875414da5bb8984860565930ecb31d7a/wechatauto/media.py) 描述的 15 字节头、AES-128-ECB/PKCS7 分段和尾段 XOR 格式，以及 ASCII/UTF-16 图片密钥候选编码。
- 上游包 `wechatauto-replica` 1.2.0 声明 Apache-2.0；原始许可证随 `wechat-reader/wechatauto-replica-LICENSE` 分发并校验。没有引入其 Python 包、自动发送、文件导出、密钥落盘或反复监控逻辑。
- 本项目重新实现有界、按需、可取消的 TypeScript 图片读取器；只对选定账号的实际加密图片做校验，图片密钥仅存于隔离读取进程，停止后清除。专用 `wxgf` 原图本轮不冒充通用图片，优先使用同图可解码缩略图。
- 同一固定提交的 [db.py](https://github.com/fanyuantaier/wechatauto-replica/blob/22ee7adf875414da5bb8984860565930ecb31d7a/wechatauto/db.py) 还用于 `global_config` 图片材料定位及推导原理参考。本项目只读取图片所需字段，不读取该结构的数据库主密钥；要求结构有效、账号名与选定账号完全相同、实际图片通过完整头段解密及填充校验，才使用推导结果。位置差异只尝试该固定来源中列明的两个值，受既有扫描时限、字节上限和取消条件约束；不代表未来微信版本必然兼容。
- 2026-08-31 本机新的只读检查：12 份 V2 样本头通过密钥和填充验证，5 张 JPEG 已实际解码为像素；不是所有微信媒体格式的兼容性承诺。真实数据的验证结论以对应版本的验收报告为准。
