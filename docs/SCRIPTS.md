# 脚本目录

## 第一批

| 文件 | 脚本 | 建议定时 |
| --- | --- | --- |
| `wxapp/batch-01/aiguo.js` | 爱裹旧衣回收 | `46 8 * * *` |
| `wxapp/batch-01/babycare.js` | Babycare 官方旗舰店 | `41 8 * * *` |
| `wxapp/batch-01/bqs.js` | 倍轻松签到 | `12 9 * * *` |
| `wxapp/batch-01/bydhy.js` | 比亚迪海洋签到 | `51 8 * * *` |
| `wxapp/batch-01/dasenlin.js` | 大参林小程序签到 | `35 8 * * *` |

## 第二批

| 文件 | 脚本 | 建议定时 |
| --- | --- | --- |
| `wxapp/batch-02/aiguoyue.js` | 爱果乐之家 | `30 8 * * *` |
| `wxapp/batch-02/ajier.js` | 安吉尔会员 | `25 8 * * *` |
| `wxapp/batch-02/baimazhixuan.js` | 白马智选 | `42 8 * * *` |
| `wxapp/batch-02/bluedash.js` | BLUE DASH 布鲁大师 | `30 8 * * *` |
| `wxapp/batch-02/bmsb.js` | 宝妈上班 | `17 8 * * *` |

## 第三批

| 文件 | 脚本 | 建议定时 |
| --- | --- | --- |
| `wxapp/batch-03/wxzf.js` | 提现笔笔省领券 | `12 11 * * *` |
| `wxapp/batch-03/提现免费券.py` | 提现免费券 | 自行设置 |
| `wxapp/batch-03/camel.js` | 骆驼 CAMEL | `18 8 * * *` |
| `wxapp/batch-03/campari.js` | 金巴厘杯中空间 | `31 8 * * *` |
| `wxapp/batch-03/casetify.js` | CASETiFY | `46 8 * * *` |

## 第四批

| 文件 | 脚本 | 建议定时 |
| --- | --- | --- |
| `wxapp/batch-04/choubao.js` | 臭宝乐园 | `30 9 * * *` |
| `wxapp/batch-04/ddyx.js` | 铛铛一下 | `32 8 * * *` |
| `wxapp/batch-04/dfrc.js` | 东风日产 | `42 9 * * *` |
| `wxapp/batch-04/dstx.js` | 都市甜心 | `47 8 * * *` |
| `wxapp/batch-04/fafa.js` | 发发藏宝洞 | `38 8 * * *` |

## 第五批

| 文件 | 脚本 | 建议定时 |
| --- | --- | --- |
| `wxapp/batch-05/feihe.js` | 飞鹤微信小程序 | `30 8 * * *` |
| `wxapp/batch-05/fej.js` | 敷尔佳 | `20 8 * * *` |
| `wxapp/batch-05/fhxmh.js` | 飞鹤星妈会 | `20 8 * * *` |
| `wxapp/batch-05/fmy.js` | 飞蚂蚁旧衣回收 | `37 8 * * *` |
| `wxapp/batch-05/fsdlb.js` | 逢三得利吧 | `30 9 * * *` |

## 第六批

| 文件 | 脚本 | 建议定时 |
| --- | --- | --- |
| `wxapp/batch-06/colorful.js` | 七彩虹 | `30 10 * * *` |
| `wxapp/batch-06/dfmfs.js` | 巅峰美缝师 | `12 9 * * *` |
| `wxapp/batch-06/dsmmhy.js` | 袋鼠妈妈会员商城 | `12 8 * * *` |
| `wxapp/batch-06/dw.js` | 得物种树 | `30 8 * * *` |
| `wxapp/batch-06/fuyouhui.js` | 复游会 | `25 8 * * *` |

## 独立脚本和模块

| 文件 | 用途 | 建议定时 |
| --- | --- | --- |
| `standalone/kangshifu_yyb.js` | 康师傅畅饮社 YYB 适配脚本 | `30 10 * * *` |
| `wxapp/tools/env.js` | 六批脚本必需的运行辅助模块 | 不单独运行 |
| `modules/wcs_yyb.js` | 旧 `wcs.js` 调用方式的可选 YYB 兼容模块 | 不单独运行 |

## 状态说明

- 六批脚本按原版业务逻辑完成 YYB 桥接层适配。
- `colorful.js`、`dfmfs.js` 和 `fuyouhui.js` 涉及手机号授权，使用 YYB 的 `/wxapp/getPhoneNumber`。
- 静态检查通过不等于真实业务接口联调成功；目标服务改版、风控或账号状态仍可能影响执行。
