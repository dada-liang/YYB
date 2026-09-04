# YYB Go 适配脚本：第六批

本批包含此前需使用授权数据的 5 个脚本：

- `colorful.js`
- `dfmfs.js`
- `dsmmhy.js`
- `dw.js`
- `fuyouhui.js`

青龙统一配置：

```text
YYB_SERVER=yyb-go:8000@账号ID或OpenID
```

多账号时每行一个，也可使用 `&` 分隔。账号后可加 `#备注`。

所有脚本使用 YYB Go 的 `POST /wxapp/getCode` 获取登录 code。`colorful.js` 和 `dfmfs.js` 保留原有手机号授权/绑定流程，并使用 `POST /wxapp/getPhoneNumber`。

`fuyouhui.js` 保留原有自动注册接口，使用 `POST /wxapp/getPhoneNumber` 获取手机号授权结果，并从真实响应中提取 `code`、`iv`、`encryptedData` 或 `encrypted_data` 后提交注册。
