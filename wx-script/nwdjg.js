/*
------------------------------------------
@Author: sm
@Date: 2024.06.07 19:15
@Description:  
cron: 34 13,21 * * *
------------------------------------------
#Notice:
浓五的酒馆 微信小程序 签到得积分
账号来源：环境变量 YYB_SERVER（服务器地址@账号ID或OpenID，多账号换行或 & 分隔）
变量名称：nwdjg（可作手动兜底入口）
⚠️【免责声明】
------------------------------------------
1、此脚本仅用于学习研究，不保证其合法性、准确性、有效性，请根据情况自行判断，本人对此不承担任何保证责任。
2、由于此脚本仅用于学习研究，您必须在下载后 24 小时内将所有内容从您的计算机或手机或任何存储设备中完全删除，若违反规定引起任何事件本人对此均不负责。
3、请勿将此脚本用于任何商业或非法目的，若违反规定请自行对此负责。
4、此脚本涉及应用与本人无关，本人对因此引起的任何隐私泄漏或其他后果不承担任何责任。
5、本人对任何脚本引发的问题概不负责，包括但不限于由脚本错误引起的任何损失和损害。
6、如果任何单位或个人认为此脚本可能涉嫌侵犯其权利，应及时通知并提供身份证明，所有权证明，我们将在收到认证文件确认后删除此脚本。
7、所有直接或间接使用、查看此脚本的人均应该仔细阅读此声明。本人保留随时更改或补充此声明的权利。一旦您使用或复制了此脚本，即视为您已接受此免责声明。
*/

const {
    Env,
    yybCacheKey
} = require("./env")
const $ = new Env("浓五的酒馆");
const WeChatServer = require("./wcs.js");
let ckName = `nwdjg`;
const strSplitor = "#";
const axios = require("axios");
const defaultUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.31(0x18001e31) NetType/WIFI Language/zh_CN miniProgram"
const MINI_APP_ID = 'wxed3cf95a14b58a26';

function parseAccount(raw = "") {
    const text = String(raw).trim(), at = text.lastIndexOf("@");
    if (at <= 0) return null;
    const rawServer = text.slice(0, at).trim().replace(/\/+$/, "");
    const identity = text.slice(at + 1), hash = identity.indexOf("#");
    const ref = (hash >= 0 ? identity.slice(0, hash) : identity).trim();
    const remark = (hash >= 0 ? identity.slice(hash + 1) : "").trim();
    if (!rawServer || !ref) return null;
    return { server: /^https?:\/\//i.test(rawServer) ? rawServer : `http://${rawServer}`, ref, openid: ref, remark };
}

class Task {
    constructor(env) {
        this.index = $.userIdx++
        this.user = env.split(strSplitor);
        this.token = null
        this.yyb = parseAccount(env)
        this.wcsid = this.yyb ? this.yyb.ref : this.user[0]
        this.wechat = this.yyb ? new WeChatServer({ url: this.yyb.server, appid: MINI_APP_ID, auth: process.env.wx_auth || "" }) : null
        this.isSign = false
        this.promotionId = ""
    }

    get headers() {
        return {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781 NetType/WIFI MiniProgramEnv/Windows WindowsWechat/WMPF XWEB/50249',
            'Content-Type': 'application/json',
            'xweb_xhr': '1',
            'sec-fetch-site': 'cross-site',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'referer': 'https://servicewechat.com/wxed3cf95a14b58a26/255/page-frame.html',
            'accept-language': 'zh-CN,zh;q=0.9',
            authorization: this.token || ''
        }
    }

    async run() {
        if (!this.yyb) {
            $.log(`账号[${this.index}] ❌ YYB_SERVER 格式无效（应为 服务器地址@账号ID或OpenID）`)
            return
        }
        //随机延迟5-30s 模拟人工操作
       await $.wait(Math.floor(Math.random() * 20 + 5) * 1000);
        let { data: codeRes } = await this.wechat.getCode(this.yyb.ref)
        if (codeRes.status) {
            await this.getUserToken(codeRes.data.code)
        } else {
            $.log(`账号[${this.index}] 获取code失败:${codeRes.message || JSON.stringify(codeRes)}❌`)
        }
        if (!this.token) {
            $.log(`账号[${this.index}] 获取用户Token失败❌`)
            return
        }
        this.token = 'Bearer ' + this.token

        await this.getUserInfo()
        await this.findSignPromotion()
        await this.doSign()
    }
    async getUserToken(code) {
        let data = ({
            "code": code,
            "appId": "wxed3cf95a14b58a26"
        });

        let options = {
            method: 'POST',
            url: 'https://stdcrm.dtmiller.com/std-weixin-mp-service/miniApp/custom/login',
            headers: this.headers,
            data: data
        };
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0') {
            this.token = result.data
            $.log(`🌸账号[${this.index}] 获取用户Token成功`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户Token-失败:${result.msg}❌`)
        }
    }
    async getUserInfo() {
        let options = {
            method: 'GET',
            url: `https://stdcrm.dtmiller.com/scrm-promotion-service/mini/wly/user/info`,
            headers: this.headers

        }
        let {
            data: result
        } = await axios.request(options);

        if (result?.code == '0') {
            $.log(`🌸账号[${this.index}] 获取用户信息[${result.data.member.mobile}] 积分[${result.data.member.points}]`)
        } else {
            $.log(`🌸账号[${this.index}] 获取用户信息-失败:${result.msg}❌`)
        }
    }

    // 签到活动每隔几个月会换一个 promotionId，写死就会收到「活动已结束!」，
    // 这里从个人中心的模块配置里取「每日签到」入口上挂的 promotionId
    async findSignPromotion() {
        try {
            let {
                data: result
            } = await axios.request({
                method: 'POST',
                url: `https://stdcrm.dtmiller.com/scrm-promotion-service/mini/module/config/list`,
                headers: this.headers,
                data: {}
            });
            let hit = JSON.stringify(result?.data || "").match(/signUp\?promotionId=(PI[0-9a-zA-Z]+)/)
            if (hit) {
                this.promotionId = hit[1]
                $.log(`🌸账号[${this.index}] 每日签到活动:${this.promotionId}`)
            } else {
                $.log(`🌸账号[${this.index}] 未找到每日签到活动入口❌`)
            }
        } catch (e) {
            $.log(`🌸账号[${this.index}] 查询签到活动异常:${e.message || e}❌`)
        }
    }

    async doSign() {
        if (!this.promotionId) {
            $.log(`🌸账号[${this.index}] 跳过签到:没有可用的签到活动`)
            return
        }
        let options = {
            method: 'GET',
            url: `https://stdcrm.dtmiller.com/scrm-promotion-service/promotion/sign/today?promotionId=${this.promotionId}`,
            headers: this.headers
        };
        let {
            data: result
        } = await axios.request(options);
        if (result?.code == '0') {
            //打印签到结果
            this.isSign = true
            let d = result.data || {}
            let prize = d.prize?.prizeName || d.prize?.virtualGiftRemark || ""
            $.log(`🌸账号[${this.index}] 签到成功 已签${d.signDays ?? "?"}天${prize ? ` 奖励:${prize}` : ""}`);
        } else if (/已签|重复/.test("" + (result?.msg || ""))) {
            this.isSign = true
            $.log(`🌸账号[${this.index}] 今日已签到`)
        } else {
            $.log(`🌸账号[${this.index}] 签到-失败:${result.msg}❌`)
        }




    }








}

!(async () => {
    await getNotice()
    $.checkEnv("YYB_SERVER");
    const manualList = String(process.env[ckName] || "").split(/\r?\n|&/).map((item) => item.trim()).filter(Boolean);
    for (const item of manualList) if (!$.userList.includes(item)) $.userList.push(item);
    $.userCount = $.userList.length;
    if (!$.userCount) {
        $.log(`未找到变量 YYB_SERVER 或 ${ckName}❌`)
        return
    }
    for (let user of $.userList) {
        await new Task(user).run();
    }
})()
    .catch((e) => console.log(e))
    .finally(() => $.done());

async function getNotice() {
    try {
        let options = {
            url: `https://ghproxy.net/https://raw.githubusercontent.com/smallfawn/Note/refs/heads/main/Notice.json`,
            headers: {
                "User-Agent": defaultUserAgent,
            },
            timeout: 3000
        }
        let {
            data: res
        } = await axios.request(options);
        $.log(res)
        return res
    } catch (e) { }

}
