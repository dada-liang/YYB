# YYB-Scrip-smallfawn

将 `smallfawn/QLScriptPublic` 中的微信小程序脚本适配到 YYB Go。适配仅替换旧微信服务接入层，保留原脚本业务接口、字段、签名、任务流程和兼容入口。

> 当前版本已通过静态审查、JavaScript/Python 语法检查和 UTF-8 检查。未连接真实 YYB 与各业务服务的脚本，不代表已经完成线上联调。

## 目录

```text
wxapp/batch-01..06/  六批共 30 个适配脚本
wxapp/tools/env.js   批量脚本必须保留的公共模块
standalone/          单独完成适配的脚本
modules/             可选的 YYB 兼容模块
dependencies/        青龙依赖清单
docs/                脚本目录和适配基线
```

完整脚本名称见 [docs/SCRIPTS.md](docs/SCRIPTS.md)。

## 青龙依赖

在青龙面板的“依赖管理”中分别添加：

- NodeJs：`axios`
- Python3：`requests`

依赖清单同时保存在 `dependencies/nodejs.txt` 和 `dependencies/python3.txt`。`fs`、`path`、`crypto`、`querystring` 等属于 Node.js 自带模块，不需要安装。

## 青龙订阅

在青龙面板打开“订阅管理”，新建订阅：

```text
名称：YYB-Scrip-smallfawn
类型：公开仓库
链接：https://github.com/dada-liang/YYB-Scrip-smallfawn.git
分支：main
定时：0 0 * * *
```

白名单和黑名单留空，保存后执行一次订阅。必须拉取完整目录，不能只复制单个 `wxapp/batch-*` 脚本，否则脚本会找不到 `wxapp/tools/env.js`。

订阅完成后，青龙通常生成目录：

```text
/ql/data/scripts/dada-liang_YYB-Scrip-smallfawn
```

如果面板生成的目录名不同，以青龙实际显示的任务路径为准。手动新建任务示例：

```bash
task dada-liang_YYB-Scrip-smallfawn/wxapp/batch-01/aiguo.js
```

```bash
task dada-liang_YYB-Scrip-smallfawn/standalone/kangshifu_yyb.js
```

各 JavaScript 文件头部已保留建议定时。`提现免费券.py` 可在青龙中按需要自行设置执行时间。

## YYB 配置

青龙环境变量：

```text
变量名：YYB_SERVER
变量值：yyb-go:8000@账号ID或OpenID
```

多账号支持换行或 `&` 分隔，也可以在账号末尾添加 `#备注`：

```text
yyb-go:8000@1#账号一
yyb-go:8000@2#账号二
```

青龙与 YYB 使用 Docker 部署时，应加入同一个 Docker 网络，`YYB_SERVER` 中使用 YYB 容器名和容器端口，不要填写青龙容器内的 `127.0.0.1`。

## 公共模块

`wxapp/tools/env.js` 是六批脚本直接引用的必需模块，订阅完整仓库后会自动存在，不需要单独配置。

`modules/wcs_yyb.js` 是给仍按旧 `wcs.js` 类方式调用的脚本准备的兼容模块。当前六批脚本不依赖它，不要为了使用批量脚本额外修改路径。

青龙的 `sendNotify.js`/Python `notify` 属于面板通知能力，本仓库不复制青龙系统文件。

## 原项目出处

https://github.com/smallfawn/QLScriptPublic.git

## 免责声明

本仓库仅用于测试、学习和研究，禁止用于商业用途。脚本依赖第三方服务，不能保证合法性、准确性、完整性、有效性或长期可用性，请使用者自行判断并承担风险。

原作者及本仓库维护者不对脚本错误、账号风险、服务变更、隐私泄露或其他直接和间接损失负责。任何单位或个人认为相关内容侵犯其权利时，请提供有效权属证明并联系删除。

请遵守所在地法律法规、目标服务条款及原项目声明，严禁形成利益链。
