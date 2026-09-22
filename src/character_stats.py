"""
character_stats — 角色数值：世界书统一字段 + 角色全局值 + 会话运行时值。

三层口径（docs/design/session-scene-plugins.md）：

1. **字段（schema）** 定义在世界书上（`WorldBook.stat_fields`）。同一本书里的角色共用
   一套字段，这样面板、提示词与第三方插件读到的键名是统一的。
2. **角色全局值** 写在角色目录 `index.md` frontmatter 的 `stats` 里，是这个角色的
   出厂 / 默认数值（角色页「数值」页签编辑）。
3. **会话运行时值** 存在会话覆盖层 `character_stats[<角色名>]`，只对本会话生效，
   随剧情树节点快照一起回档（场景面板「数值」页与插件接口写这里）。

合并顺序：字段默认值 → 角色全局值 → 会话值。字段外的自定义键也保留（自由填写），
只是不做类型校验。
"""

from __future__ import annotations

import re
from typing import Any

STAT_FIELD_TYPES = ("number", "text", "bool", "select")
MAX_STAT_FIELDS = 64
MAX_CUSTOM_KEYS = 64
_KEY_RE = re.compile(r"^[A-Za-z0-9_\-一-鿿぀-ヿ가-힯]{1,32}$")


def is_valid_stat_key(key: Any) -> bool:
    """键名：字母 / 数字 / 下划线 / 连字符 / 中日韩文字，1–32 字符。"""
    return isinstance(key, str) and bool(_KEY_RE.match(key))


def _to_number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            if re.fullmatch(r"[-+]?\d+", text):
                return int(text)
            return float(text)
        except ValueError:
            return None
    return None


def normalize_stat_field(raw: Any) -> dict | None:
    """规范化单个字段定义；键名非法或结构不对返回 None（由调用方决定是否报错）。"""
    if not isinstance(raw, dict):
        return None
    key = str(raw.get("key", "") or "").strip()
    if not is_valid_stat_key(key):
        return None
    ftype = str(raw.get("type", "number") or "number").strip().lower()
    if ftype not in STAT_FIELD_TYPES:
        ftype = "number"
    field: dict[str, Any] = {
        "key": key,
        "label": str(raw.get("label", "") or "").strip() or key,
        "type": ftype,
    }
    group = str(raw.get("group", "") or "").strip()
    if group:
        field["group"] = group[:32]
    description = str(raw.get("description", "") or "").strip()
    if description:
        field["description"] = description[:200]
    if ftype == "number":
        for bound in ("min", "max", "step"):
            number = _to_number(raw.get(bound))
            if number is not None:
                field[bound] = number
        if "min" in field and "max" in field and field["min"] > field["max"]:
            field["min"], field["max"] = field["max"], field["min"]
        default = _to_number(raw.get("default"))
        field["default"] = clamp_number(field, default if default is not None else 0)
    elif ftype == "bool":
        field["default"] = bool(raw.get("default", False))
    elif ftype == "select":
        options = raw.get("options")
        if isinstance(options, str):
            options = [o.strip() for o in re.split(r"[,，、|\n]", options)]
        cleaned: list[str] = []
        for option in options if isinstance(options, list) else []:
            text = str(option or "").strip()
            if text and text not in cleaned:
                cleaned.append(text[:40])
        field["options"] = cleaned[:32]
        default = str(raw.get("default", "") or "").strip()
        field["default"] = default if default in cleaned else (cleaned[0] if cleaned else "")
    else:  # text
        field["default"] = str(raw.get("default", "") or "")[:500]
    return field


def normalize_stat_fields(value: Any) -> list[dict]:
    """规范化字段列表：去掉非法项、按 key 去重（保留先出现的）、上限 MAX_STAT_FIELDS。"""
    result: list[dict] = []
    seen: set[str] = set()
    for raw in value if isinstance(value, list) else []:
        field = normalize_stat_field(raw)
        if field is None or field["key"] in seen:
            continue
        seen.add(field["key"])
        result.append(field)
        if len(result) >= MAX_STAT_FIELDS:
            break
    return result


def validate_stat_fields(value: Any) -> list[dict]:
    """严格校验（API 写入用）：非列表 / 含非法键 / 重复键都抛 ValueError。"""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("stat_fields 必须是数组")
    if len(value) > MAX_STAT_FIELDS:
        raise ValueError(f"数值字段最多 {MAX_STAT_FIELDS} 个")
    seen: set[str] = set()
    result: list[dict] = []
    for index, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f"第 {index + 1} 个字段不是对象")
        key = str(raw.get("key", "") or "").strip()
        if not is_valid_stat_key(key):
            raise ValueError(f"第 {index + 1} 个字段的键名非法：{key!r}（1–32 位字母 / 数字 / 下划线 / 中文）")
        if key in seen:
            raise ValueError(f"字段键名重复：{key}")
        seen.add(key)
        ftype = str(raw.get("type", "number") or "number").strip().lower()
        if ftype not in STAT_FIELD_TYPES:
            raise ValueError(f"字段 {key} 的类型必须是 {' / '.join(STAT_FIELD_TYPES)}")
        field = normalize_stat_field(raw)
        if field is None:
            raise ValueError(f"字段 {key} 无法规范化")
        result.append(field)
    return result


def clamp_number(field: dict, value: float | int) -> float | int:
    low, high = field.get("min"), field.get("max")
    if low is not None and value < low:
        value = low
    if high is not None and value > high:
        value = high
    return value


def coerce_value(field: dict | None, raw: Any) -> Any:
    """按字段类型转换一个值；没有字段定义（自定义键）时只做 JSON 标量约束。

    返回 None 表示「无法接受」，调用方应报错或忽略。
    """
    if field is None:
        if isinstance(raw, (bool, int, float)):
            return raw
        if isinstance(raw, str):
            return raw[:500]
        return None
    ftype = field.get("type", "number")
    if ftype == "number":
        number = _to_number(raw)
        if number is None:
            return None
        return clamp_number(field, number)
    if ftype == "bool":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, (int, float)):
            return bool(raw)
        if isinstance(raw, str):
            text = raw.strip().lower()
            if text in ("true", "1", "yes", "是", "on"):
                return True
            if text in ("false", "0", "no", "否", "off", ""):
                return False
        return None
    if ftype == "select":
        text = str(raw if raw is not None else "").strip()
        options = field.get("options") or []
        return text if (not options or text in options) else None
    # text
    if raw is None:
        return ""
    return str(raw)[:500]


def sanitize_values(fields: list[dict], values: Any, *, strict: bool = False) -> dict:
    """把一份 {key: value} 按字段定义清洗。

    - 字段内的键按类型转换；`None` 表示删除该键（由调用方处理，这里原样保留 None）。
    - 字段外的自定义键：只接受 JSON 标量，最多 MAX_CUSTOM_KEYS 个。
    - strict=True 时，任何无法转换的值都抛 ValueError（API 写入）；否则静默丢弃（读取旧数据）。
    """
    if values is None:
        return {}
    if not isinstance(values, dict):
        if strict:
            raise ValueError("values 必须是对象")
        return {}
    by_key = {f["key"]: f for f in fields}
    out: dict[str, Any] = {}
    custom = 0
    for raw_key, raw in values.items():
        key = str(raw_key or "").strip()
        if not is_valid_stat_key(key):
            if strict:
                raise ValueError(f"键名非法：{raw_key!r}")
            continue
        if raw is None:
            out[key] = None
            continue
        field = by_key.get(key)
        if field is None:
            custom += 1
            if custom > MAX_CUSTOM_KEYS:
                if strict:
                    raise ValueError(f"自定义数值最多 {MAX_CUSTOM_KEYS} 个")
                continue
        coerced = coerce_value(field, raw)
        if coerced is None:
            if strict:
                label = field["label"] if field else key
                raise ValueError(f"「{label}」的值无法接受：{raw!r}")
            continue
        out[key] = coerced
    return out


def merge_character_stats(fields: list[dict], global_values: Any,
                          session_values: Any) -> tuple[dict, dict]:
    """合并三层，返回 (values, sources)。

    values：字段默认值 → 角色全局值 → 会话值；字段外的自定义键也保留。
    sources：每个键的来源 `default` / `global` / `session`，前端用来标「会话覆盖」。
    """
    values: dict[str, Any] = {}
    sources: dict[str, str] = {}
    for field in fields:
        values[field["key"]] = field.get("default")
        sources[field["key"]] = "default"
    for layer, source in ((global_values, "global"), (session_values, "session")):
        for key, value in sanitize_values(fields, layer).items():
            if value is None:
                continue
            values[key] = value
            sources[key] = source
    return values, sources


def format_stat_value(field: dict | None, value: Any) -> str:
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value)
    if field and field.get("type") == "number" and field.get("max") is not None:
        top = field["max"]
        if isinstance(top, float) and top.is_integer():
            top = int(top)
        text = f"{text}/{top}"
    return text


def format_stats_block(fields: list[dict], per_character: dict[str, dict],
                       *, tag: str = "character_stats") -> str:
    """把「角色 → 数值」渲染成注入提示词的 XML 块；没有任何数值时返回空串。

    每行：`角色名：标签 值、标签 值`。数值字段带上限时写成 `值/上限`。
    只列有值的键，避免把一堆默认 0 也塞进上下文。
    """
    by_key = {f["key"]: f for f in fields}
    lines: list[str] = []
    for name, values in per_character.items():
        parts: list[str] = []
        for key, value in (values or {}).items():
            if value is None or value == "":
                continue
            field = by_key.get(key)
            label = field["label"] if field else key
            parts.append(f"{label} {format_stat_value(field, value)}")
        if parts:
            lines.append(f"{name}：{'、'.join(parts)}")
    if not lines:
        return ""
    return (f"<{tag}>\n"
            "以下是角色当前的数值状态（由系统维护，叙述时应与之相符，不要自行改写数字）：\n"
            + "\n".join(lines) + f"\n</{tag}>")


def read_global_stats_from_meta(metadata: Any) -> dict:
    """从角色 frontmatter 取 `stats`（缺失 / 类型不对 → 空）。"""
    if not isinstance(metadata, dict):
        return {}
    stats = metadata.get("stats")
    return dict(stats) if isinstance(stats, dict) else {}
