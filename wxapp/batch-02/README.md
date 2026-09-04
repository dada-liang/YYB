# YYB Go 适配脚本：第二批

本批包含 5 个脚本：

- `aiguoyue.js`
- `ajier.js`
- `baimazhixuan.js`
- `bluedash.js`
- `bmsb.js`

青龙统一配置：

```text
YYB_SERVER=yyb-go:8000@账号ID或OpenID
```

多账号时每行一个，也可使用 `&` 分隔。账号后可加 `#备注`。

脚本仅使用 YYB Go 的 `POST /wxapp/getCode` 获取 `wx.login` code，不再依赖旧的 `env.js`、`wcs.js`、`wx_server_url` 或 `wx_auth`。
