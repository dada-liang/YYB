#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# 漓泉啤酒生态营地 - 每日签到得积分
# 入口: 微信小程序「漓泉啤酒生态营地」-> 会员中心 -> 每日签到
# 说明: 通过 YYB(/wxapp/getCode) 用账号换取 wx.login code, 复刻小程序的
#       会员静默登录 (mbr/members/wxLogin/{code}) 拿到 Token, 再完成每日签到。
# 接口契约 (来自小程序主包 common/vendor.js 反编译):
#   登录  GET  /api/mbr/members/wxLogin/{code}?appId=<appid>
#            -> errcode==0 且 data.b2cMemberId/openid 存在; data.token 为会话凭证
#   鉴权  请求头 Token: <token>   (响应拦截器: errcode||code, 200 成功, 401 会话失效)
#   状态  GET  /api/b2c/member/sign/task/list  -> data.signRes.{sign, signNum,
#            taskSignDtoList[{signTime, signStatus}]}   sign==true / 今日行
#            signStatus=="sign" 即今日已签 (幂等预检依据)
#   签到  POST /api/b2c/member/sign/task  body {}  -> code==200, data.signRes.sign==true
#   积分  GET  /api/b2c/member/pointsAndCouponCardNumAndShopCardInfo?unionId=<unionId>
#            -> data.MemberCouponShopPointsVo.pointsNum   (仅用于上报余额)
# 账号来源: 环境变量 YYB_SERVER (格式: 服务器地址@账号ID或OpenID, 多账号用换行或 & 分割, 可选 #备注)
#new Env("漓泉啤酒签到")
#cron 31 12 * * *

import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

try:
    from notify import send
except Exception:
    def send(title, content):
        print(f"\n===== {title} =====\n{content}")

# ---------------------------------------------------------------------------
# 常量 (均来自小程序反编译源码, 非机密)
# ---------------------------------------------------------------------------
MINI_APP_ID = "wx08dabaec2783f4e9"
BASE_URL = "https://api.mbr.liquan.com/api"          # vendor.js api_HOST
SUCCESS_CODE = 200
SESSION_INVALID_CODE = 401                            # 拦截器: 清 token 并重新登录
SIGNED = "sign"                                       # taskSignDtoList[].signStatus

# YYB 账号来源 (只从环境变量 YYB_SERVER 读取, 绝不硬编码服务器地址)

TOKEN_CACHE_PATH = Path(__file__).with_name("liquanpijiu_token_cache.json")
DEFAULT_UA = (
    "Mozilla/5.0 (Linux; Android 13; SM-G9910 Build/TP1A.220624.014) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36 "
    "MicroMessenger/8.0.49.2600(0x28003137) NetType/WIFI Language/zh_CN "
    "miniProgram/" + MINI_APP_ID
)

session = requests.Session()


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
def bj_now():
    return datetime.now(timezone(timedelta(hours=8)))


def mask(value):
    if not value:
        return ""
    value = str(value)
    if len(value) <= 12:
        return value[:2] + "***"
    return f"{value[:6]}***{value[-4:]}"


def read_token_cache():
    try:
        if TOKEN_CACHE_PATH.exists():
            return json.loads(TOKEN_CACHE_PATH.read_text(encoding="utf-8")) or {}
    except Exception:
        pass
    return {}


def write_token_cache(cache):
    try:
        TOKEN_CACHE_PATH.write_text(
            json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"⚠️ 写入token缓存失败: {e}")


def get_cached_session(account):
    return read_token_cache().get(account_cache_key(account)) or {}


def save_cached_session(account, token, union_id):
    cache = read_token_cache()
    cache[account_cache_key(account)] = {"token": token, "unionId": union_id,
                     "updatedAt": int(time.time())}
    write_token_cache(cache)


def remove_cached_session(account):
    cache = read_token_cache()
    key = account_cache_key(account)
    if key in cache:
        del cache[key]
        write_token_cache(cache)


def parse_yyb_account(raw):
    text = str(raw or "").strip()
    left, sep, remark = text.partition("#")
    server, at, ref = left.rpartition("@")
    if not at or not server.strip() or not ref.strip():
        raise ValueError(f"YYB_SERVER 格式无效(应为 服务器地址@账号ID或OpenID): {text}")
    server = server.strip().rstrip("/")
    if not server.lower().startswith(("http://", "https://")):
        server = "http://" + server
    return {"server": server, "ref": ref.strip(), "remark": remark.strip()}


def account_cache_key(account):
    if isinstance(account, dict):
        return f"{account.get('server', '').lower()}@{account.get('ref', '')}"
    return str(account)


def extract_yyb_code(payload):
    result = payload.get("result") if isinstance(payload, dict) else None
    data = payload.get("data") if isinstance(payload, dict) else None
    nested = data.get("result") if isinstance(data, dict) else None
    candidates = [nested, result]
    candidates.extend([item.get("raw") for item in (result, nested) if isinstance(item, dict)])
    for item in candidates:
        if isinstance(item, str):
            try:
                item = json.loads(item)
            except (TypeError, ValueError):
                continue
        if isinstance(item, dict) and isinstance(item.get("code"), str) and item["code"]:
            return item["code"]
    return ""


# ---------------------------------------------------------------------------
# YYB: 账号 -> wx.login code
# ---------------------------------------------------------------------------
def get_wx_code(account):
    body = {"ref": account["ref"], "app_id": MINI_APP_ID}
    last_msg = ""
    for attempt in range(4):
        if attempt:
            time.sleep(3)
        resp = session.post(f"{account['server']}/wxapp/getCode", json=body,
                            headers={"Content-Type": "application/json"}, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, dict) or data.get("code") != 0:
            last_msg = f"YYB取 code 失败: {data.get('msg') if isinstance(data, dict) else data}"
            continue
        code = extract_yyb_code(data)
        if code:
            return code
        last_msg = f"YYB未返回 code: {data}"
    raise RuntimeError(f"YYB获取 code 失败(已重试): {last_msg}")


# ---------------------------------------------------------------------------
# 漓泉会员 API
# ---------------------------------------------------------------------------
def api_headers(token=None):
    headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": DEFAULT_UA,
        "Referer": f"https://servicewechat.com/{MINI_APP_ID}/0/page-frame.html",
    }
    if token:
        headers["Token"] = token            # 请求拦截器: headers.Token = 本地 token
    return headers


def api_get(path, token=None, params=None):
    resp = session.get(f"{BASE_URL}{path}", params=params or {},
                       headers=api_headers(token), timeout=30)
    resp.raise_for_status()
    return resp.json()


def api_post(path, body, token=None):
    resp = session.post(f"{BASE_URL}{path}",
                        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                        headers=api_headers(token), timeout=30)
    resp.raise_for_status()
    return resp.json()


def resp_code(resp):
    """拦截器口径: errcode 优先, 否则 code。"""
    node = resp if isinstance(resp, dict) else {}
    for key in ("errcode", "code"):
        v = node.get(key)
        if v is not None:
            try:
                return int(v)
            except (TypeError, ValueError):
                pass
    return -1


def resp_msg(resp):
    node = resp if isinstance(resp, dict) else {}
    for key in ("errmsg", "message", "msg"):
        v = node.get(key)
        if v:
            return str(v)
    data = node.get("data")
    if isinstance(data, dict) and data.get("error"):
        return str(data["error"])
    return ""


# ---------------------------------------------------------------------------
# 登录 / 会话
# ---------------------------------------------------------------------------
def login(account):
    """wx.login code -> wxLogin -> (token, unionId)。code 放在 URL 路径中。"""
    code = get_wx_code(account)
    resp = api_get(f"/mbr/members/wxLogin/{code}", params={"appId": MINI_APP_ID})
    if resp_code(resp) != 0:
        raise RuntimeError(f"登录失败: {resp_msg(resp) or resp_code(resp)}")
    data = resp.get("data") or {}
    token = data.get("token")
    union_id = data.get("unionid") or (data.get("wxUserInfo") or {}).get("unionId")
    if not (token and data.get("b2cMemberId")):
        raise RuntimeError("登录响应缺少 token/b2cMemberId, 需在小程序内登录一次后重试")
    return token, union_id


def obtain_session(account, index, force=False):
    if force:
        remove_cached_session(account)
    else:
        cached = get_cached_session(account)
        if cached.get("token"):
            print(f"账号 {index} 使用缓存 token: {mask(cached['token'])}")
            return cached["token"], cached.get("unionId")
    token, union_id = login(account)
    save_cached_session(account, token, union_id)
    print(f"账号 {index} 静默登录成功: {mask(token)}")
    return token, union_id


# ---------------------------------------------------------------------------
# 签到业务
# ---------------------------------------------------------------------------
def sign_state(token):
    return api_get("/b2c/member/sign/task/list", token=token)


def do_sign(token):
    return api_post("/b2c/member/sign/task", {}, token=token)


def points_balance(token, union_id):
    """仅读取积分余额用于上报, 失败返回 None (不影响签到结论)。"""
    if not union_id:
        return None
    try:
        resp = api_get("/b2c/member/pointsAndCouponCardNumAndShopCardInfo",
                       token=token, params={"unionId": union_id})
        if resp_code(resp) != SUCCESS_CODE:
            return None
        vo = (resp.get("data") or {}).get("MemberCouponShopPointsVo") or {}
        return vo.get("pointsNum")
    except Exception:
        return None


def sign_res(resp):
    data = resp.get("data") if isinstance(resp, dict) else None
    if isinstance(data, dict) and isinstance(data.get("signRes"), dict):
        return data["signRes"]
    return {}


def signed_today(res):
    """今日已签: signRes.sign 为真, 或今日日期行 signStatus == 'sign'。"""
    if res.get("sign") is True:
        return True
    today = bj_now().strftime("%Y-%m-%d")
    for row in res.get("taskSignDtoList") or []:
        if row.get("signTime") == today and row.get("signStatus") == SIGNED:
            return True
    return False


def fmt_num(value):
    """服务端 signNum 为浮点(1.0), 展示成整数更自然。"""
    try:
        f = float(value)
        return str(int(f)) if f == int(f) else str(f)
    except (TypeError, ValueError):
        return str(value)


def run_account(account, index):
    lines = [f"【账号 {index}】"]

    token, union_id = obtain_session(account, index)

    # 读取签到状态 (首个鉴权调用); 会话失效则强制重登重试一次
    state = sign_state(token)
    if resp_code(state) == SESSION_INVALID_CODE:
        print(f"账号 {index} 会话失效, 重新登录...")
        token, union_id = obtain_session(account, index, force=True)
        state = sign_state(token)

    scode = resp_code(state)
    if scode != SUCCESS_CODE:
        msg = resp_msg(state) or f"获取签到状态失败 code={scode}"
        print(f"❌ 账号 {index} {msg}")
        lines.append(f"❌ {msg}")
        return "\n".join(lines), False

    res = sign_res(state)

    # 幂等预检: 今日已签则不再提交
    if signed_today(res):
        msg = f"今日已签到, 无需重复 (本周已签 {fmt_num(res.get('signNum'))} 天)"
        print(f"✅ 账号 {index} {msg}")
        lines.append(f"✅ {msg}")
        pts = points_balance(token, union_id)
        if pts is not None:
            lines.append(f"当前积分: {pts}")
            print(f"账号 {index} 当前积分: {pts}")
        return "\n".join(lines), True

    # 执行一次签到
    result = do_sign(token)
    rcode = resp_code(result)
    if rcode == SESSION_INVALID_CODE:
        print(f"账号 {index} 会话失效, 重新登录后重试签到...")
        token, union_id = obtain_session(account, index, force=True)
        result = do_sign(token)
        rcode = resp_code(result)

    if rcode != SUCCESS_CODE:
        msg = resp_msg(result) or f"签到失败 code={rcode}"
        print(f"❌ 账号 {index} {msg}")
        lines.append(f"❌ {msg}")
        return "\n".join(lines), False

    res = sign_res(result)
    if not signed_today(res) and res.get("sign") is not True:
        msg = resp_msg(result) or "签到接口返回成功但未标记已签, 请稍后重试"
        print(f"⚠️ 账号 {index} {msg}")
        lines.append(f"⚠️ {msg}")
        return "\n".join(lines), False

    msg = f"签到成功, 本周已签 {fmt_num(res.get('signNum'))} 天"
    print(f"🎉 账号 {index} {msg}")
    lines.append(f"🎉 {msg}")

    pts = points_balance(token, union_id)
    if pts is not None:
        lines.append(f"当前积分: {pts}")
        print(f"账号 {index} 当前积分: {pts}")
    return "\n".join(lines), True


def main():
    raw = os.getenv("YYB_SERVER", "")
    accounts = []
    for x in raw.replace("&", "\n").splitlines():
        if not x.strip():
            continue
        try:
            accounts.append(parse_yyb_account(x))
        except ValueError as e:
            print(f"❌ {e}")
    if not accounts and os.getenv("lqpj", "").strip():
        print("❌ 检测到旧变量 lqpj：本脚本账号来源已改为环境变量 YYB_SERVER（格式：服务器地址@账号ID或OpenID），请迁移配置。")

    if not accounts:
        print("❌ 未检测到账号信息(环境变量 YYB_SERVER), 退出。")
        return

    print("=============== 漓泉啤酒 签到开始 ===============")
    summaries = []
    ok_count = 0
    for i, account in enumerate(accounts, 1):
        remark = account["remark"]
        print(f"\n-------------- 账号 {i}{('/' + remark) if remark else ''} --------------")
        try:
            summary, ok = run_account(account, i)
            summaries.append(summary)
            ok_count += 1 if ok else 0
        except Exception as e:
            print(f"❌ 账号 {i} 执行异常: {e}")
            summaries.append(f"【账号 {i}】\n❌ 执行异常: {e}")
        time.sleep(1)

    print("\n=============== 漓泉啤酒 签到结束 ===============")
    title = f"漓泉啤酒签到 {ok_count}/{len(entries)} 成功"
    try:
        send(title, "\n\n".join(summaries))
    except Exception as e:
        print(f"⚠️ 通知发送失败: {e}")


if __name__ == "__main__":
    main()
