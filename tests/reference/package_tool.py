#!/usr/bin/env python3
"""NOB V3 普通音频检查及参考重建工具。BNL 转换入口为同目录 bnl_to_nob.py。"""

import argparse
import functools
import hashlib
import json
import operator
from pathlib import Path
import struct
import sys

VERSION = "0.2.0-research"
VERIFY_TEXT = b"abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ=-"
HEADER_END = 0xC40
BODY_START = 0xC44


class FormatError(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise FormatError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def take(data, start, length, label):
    require(start >= 0 and length >= 0 and start + length <= len(data),
            f"{label} 越界：offset={start}, length={length}, size={len(data)}")
    return data[start:start + length]


def u32(data, offset):
    return struct.unpack("<I", take(data, offset, 4, "u32"))[0]


def xor_audio(data, key):
    require(len(key) == 32, "NOB 音频 XOR 参数必须为 32 字节")
    out = bytearray(len(data))
    for i, key_byte in enumerate(key):
        table = bytes(x ^ key_byte for x in range(256))
        out[i::32] = data[i::32].translate(table)
    return bytes(out)


def header_crc(data, signed_shift):
    # 官方 libnobV3.dll 的表在索引 150 与标准 CRC32 表不同。
    table = []
    for value in range(256):
        for _ in range(8):
            value = (value >> 1) ^ (0xEDB88320 if value & 1 else 0)
        table.append(value)
    table[150] = 0x256C3671
    crc = 0
    for value in data:
        shifted = (crc >> 8) | (0xFF000000 if signed_shift and crc & 0x80000000 else 0)
        crc = shifted ^ table[(crc ^ value) & 255]
    return crc


def body_digest(data):
    return bytes(functools.reduce(operator.xor, data[i::128], 0) for i in range(128))


def _ranges(data):
    result = []
    for p in range(0x200, 0x300, 8):
        start, end = struct.unpack_from("<II", data, p)
        if start == 0:
            require(not any(data[p:0x300]), "适用码范围终止项后有未识别内容")
            break
        require(start <= end, "适用码范围倒置")
        result.append([start, end])
    return result


def inspect_nob(data, source_name="", keep_audio=False):
    require(len(data) >= BODY_START + 128, "NOB 长度不足")
    require(data[:4] == b"NOB\0", "不是 NOB 文件")
    require(data[8:10] == b"V3", "尚未支持此 NOB 版本")
    require(u32(data, 0x10) == 0xB0, "未知 NOB V3 头长度")
    require(u32(data, 0x6C) == len(data), "NOB 声明长度与实际长度不一致")
    lib_date = data[0x14:0x1C].decode("ascii")
    require(lib_date.isdigit(), "NOB 库日期异常")
    crc = header_crc(data[:HEADER_END], lib_date > "20201105")
    require(crc == u32(data, HEADER_END), "NOB 头校验不匹配")
    require(body_digest(data[BODY_START:-128]) == data[-128:], "NOB 全部正文摘要不匹配")

    # 固定的公开校验串两半提供同一组文件音频 XOR 参数；这不涉及登录服务。
    key = bytes(a ^ b for a, b in zip(data[0x300:0x320], VERIFY_TEXT[:32]))
    require(xor_audio(data[0x300:0x340], key) == VERIFY_TEXT,
            "NOB 校验区不符合已验证的公开格式")
    audio_start = u32(data, 0x44)
    index_start, index_size = struct.unpack_from("<II", data, 0x4C)
    require(index_size % 12 == 0, "普通点位索引长度不是 12 的倍数")
    require(BODY_START <= index_start <= audio_start <= len(data) - 128, "NOB 区域顺序异常")
    require(index_start + index_size <= audio_start, "普通索引与音频区重叠")
    take(data, index_start, index_size, "点位索引")

    aliases = []
    for p in range(0x340, 0x440, 4):
        value = u32(data, p)
        if value:
            aliases.append({"oid": value & 0x7FFFFFFF, "raw": value})
    ranges = _ranges(data)
    sections = [{"header_offset": h, "offset": u32(data, h), "length": u32(data, h + 4)}
                for h in (0x54, 0x5C, 0x64)]
    for section in sections:
        take(data, section["offset"], section["length"], "其他索引区")

    points = []
    unsupported = []
    audios = {}
    record_spans = []
    previous_oid = -1
    for p in range(index_start, index_start + index_size, 12):
        oid, index_type, index_length, record = struct.unpack_from("<IHHI", data, p)
        require(oid > previous_oid, "点位索引未严格递增或有重复点读码")
        previous_oid = oid
        # 选模式功能码属于当前书，不加入选书范围，以免多本书争用全局按钮。
        require(index_type == 3 or not ranges or any(a <= oid <= b for a, b in ranges),
                "普通点位超出声明适用码范围")
        point = {"oid": oid, "index_type": index_type, "index_length": index_length,
                 "record_offset": record}
        require(BODY_START <= record < index_start, "点位记录不在记录区")
        if index_type not in (1, 3) or index_length != 12:
            unsupported.append({"oid": oid, "reason": "未知普通索引类型", "type": index_type,
                                "length": index_length, "offset": record})
            points.append(point)
            continue
        payload_length, command, flags = struct.unpack("<III", take(data, record, 12, "指令"))
        point.update(command=command, flags=flags, payload_length=payload_length)
        play_mode, scene_count = command & 255, (command >> 8) & 255
        if index_type == 3:
            require(payload_length == 12 and command < 256 and flags > 0,
                    '模式切换记录异常')
            scene_specs = [(record+12, flags)]
            point.update(scene_index=command, playback='scene_switch')
            record_spans.append((record, record+12))
        elif payload_length != 12 or command >> 16 or play_mode not in (1, 2) or not 1 <= scene_count <= 32 or flags != 0:
            unsupported.append({"oid": oid, "reason": "未验证的播放指令", "command": command,
                                "flags": flags, "payload_length": payload_length, "offset": record})
            points.append(point)
            continue
        else:
            scene_specs = [struct.unpack('<II', take(data, record+12+8*i, 8, '场景引用表'))
                           for i in range(scene_count)]
            record_spans.append((record, record+12+8*scene_count))
            point.update(play_mode=play_mode, scene_count=scene_count)
        scenes = []
        for list_start, count in scene_specs:
            require(count > 0, "零引用普通播放指令会误读相邻记录或触发原库错误")
            require(index_type == 3 or play_mode != 2 or scene_count == 1 or count == 1,
                    "多场景模式 2 的轮播尚未核对")
            require(count <= (index_start-BODY_START)//8, '音频引用数量超出记录区容量')
            require(BODY_START <= list_start <= index_start and list_start+count*8 <= index_start,
                    '音频引用表越界')
            refs = []
            for j in range(count):
                offset, length = struct.unpack_from('<II', data, list_start+j*8)
                require(offset+length <= len(data)-128-audio_start, '音频引用越界')
                identity = offset, length
                if identity not in audios:
                    decoded = xor_audio(take(data, audio_start+offset, length, '音频'), key)
                    audio = dict(id=f'a{len(audios):05d}', offset=offset, length=length,
                                 sha256=sha256(decoded), prefix_hex=decoded[:16].hex(), zero_length=length == 0)
                    if keep_audio:
                        audio['data'] = decoded
                    audios[identity] = audio
                refs.append(audios[identity]['id'])
            scenes.append(refs)
            record_spans.append((list_start, list_start+count*8))
        refs = [ref for scene in scenes for ref in scene]
        point.update(audio_refs=refs, audio_count=len(refs), list_offset=scene_specs[0][0],
                     scene_audio_refs=scenes)
        if index_type == 1:
            # 原 DLL _process_oid_normal 对单场景 mode2 每次选择一条，
            # 连续点击按原列表轮换；单引用与普通单段行为相同。
            point['playback'] = 'cycle' if play_mode == 2 and scene_count == 1 and len(refs) > 1 else 'sequence'
        points.append(point)

    unique_ranges = sorted((a["offset"], a["offset"] + a["length"]) for a in audios.values()
                           if a["length"])
    cursor = 0
    gaps = []
    for start, end in unique_ranges:
        require(start >= cursor, "存在部分重叠的不同音频引用，尚未支持")
        if start > cursor:
            gaps.append([cursor, start])
        cursor = end
    if cursor < len(data) - 128 - audio_start:
        gaps.append([cursor, len(data) - 128 - audio_start])
    covered = sum(end - start for start, end in unique_ranges)
    count_refs = sum(p.get("audio_count", 0) for p in points)
    # 未引用的非零记录不能当作填充删除；可能是尚未识别的播放或互动数据。
    record_coverage = bytearray(index_start - BODY_START)
    for start, end in record_spans:
        record_coverage[start - BODY_START:end - BODY_START] = b"\1" * (end - start)
    unknown_record_bytes = sum(value != 0 and not used for value, used in
                               zip(data[BODY_START:index_start], record_coverage))
    for section in sections:
        if section["length"]:
            unsupported.append({"reason": "其他索引区尚未解析", **section})
    return {
        "tool_version": VERSION, "source": source_name, "format": "NOB V3",
        "file_size": len(data), "sha256": sha256(data), "lib_date": lib_date,
        "created": data[0x24:0x34].rstrip(b"\0").decode("ascii"),
        "identity": {"customer_id": u32(data, 0x34), "book_id": u32(data, 0x38),
                     "cover_oid": u32(data, 0x3C), "book_sub_id": data[0x42],
                     "book_type": struct.unpack_from("<H", data, 0x40)[0],
                     "encryption_flag": data[0x43], "oid_ranges": ranges, "cover_aliases": aliases},
        "regions": {"index_offset": index_start, "index_size": index_size,
                    "audio_offset": audio_start, "other_sections": sections},
        "checks": {"header_crc": "pass", "body_digest": "pass", "verify_area": "pass",
                   "index_sorted_unique": "pass", "audio_bounds": "pass",
                   "audio_region_fully_referenced": not gaps,
                   "audio_bytes_covered": covered, "unreferenced_audio_ranges": gaps,
                   "unparsed_nonzero_record_bytes": unknown_record_bytes,
                   "reference_count": count_refs, "shared_reference_count": count_refs - len(audios),
                   "t6_pen_test": "not_performed"},
        "point_count": len(points), "unique_audio_count": len(audios),
        "points": points, "audios": list(audios.values()), "unsupported": unsupported,
    }


def rebuild_reference(data):
    """仅用于验证普通 NOB 的索引/音频封装规则，保留参考身份，不用于 BNL 转换。"""
    model = inspect_nob(data, keep_audio=True)
    require(all(p['index_type'] == 1 and p.get('scene_count', 1) == 1 for p in model['points']),
            '多场景及切换记录不能按单场景参考包重建')
    require(not model["unsupported"], "包含未验证的指令，拒绝重建")
    require(not any(s["length"] for s in model["regions"]["other_sections"]), "存在其他索引区")
    require(model["checks"]["audio_region_fully_referenced"], "存在未引用音频，拒绝遗漏")
    require(model["checks"]["unparsed_nonzero_record_bytes"] == 0,
            "记录区存在未解析的非零数据，拒绝遗漏")
    index_end = model["regions"]["index_offset"] + model["regions"]["index_size"]
    gap = data[index_end:model["regions"]["audio_offset"]]
    # 两个 20230726 参考含空 COMMON_AUDIO 表；仅保留已核对的全空形式。
    require(not gap or gap == b"COMMON_AUDIO" + bytes(4112 - 12),
            "索引与音频间存在未识别内容，拒绝遗漏或猜测关联地址")
    key = bytes(a ^ b for a, b in zip(data[0x300:0x320], VERIFY_TEXT[:32]))
    audio_offsets = {}
    audio_blob = bytearray()
    for audio in model["audios"]:
        audio_offsets[audio["id"]] = (len(audio_blob), audio["length"])
        audio_blob.extend(xor_audio(audio["data"], key))
    out = bytearray(data[:BODY_START])
    index = bytearray()
    for point in model["points"]:
        record = len(out)
        refs = point["audio_refs"]
        out.extend(struct.pack("<5I", 12, point["command"], 0, record + 20, len(refs)))
        for ref in refs:
            out.extend(struct.pack("<II", *audio_offsets[ref]))
        index.extend(struct.pack("<IHHI", point["oid"], 1, 12, record))
    out.extend(bytes((-len(out)) % 512))
    index_start = len(out)
    out.extend(index)
    out.extend(gap)
    audio_start = len(out)
    out.extend(audio_blob)
    struct.pack_into("<I", out, 0x44, audio_start)
    struct.pack_into("<II", out, 0x4C, index_start, len(index))
    struct.pack_into("<I", out, 0x6C, len(out) + 128)
    struct.pack_into("<I", out, HEADER_END,
                     header_crc(out[:HEADER_END], model["lib_date"] > "20201105"))
    out.extend(body_digest(out[BODY_START:]))
    # 调用者还应使用独立过程重新读取，不依赖构造过程中维护的地址。
    return bytes(out)


def compare_nob(left, right):
    """按点读码、指令、播放顺序及实际共享引用比较，忽略重新分配的物理偏移。"""
    a, b = inspect_nob(left), inspect_nob(right)
    require(not a["unsupported"] and not b["unsupported"], "不能对未知指令宣称语义一致")

    def playback(model):
        audios = {x["id"]: x for x in model["audios"]}
        return [{"oid": p["oid"], "index_type": p["index_type"], "command": p["command"],
                 "flags": p["flags"], "refs": p["audio_refs"],
                 "audio": [{"sha256": audios[r]["sha256"], "length": audios[r]["length"],
                            "zero_length": audios[r]["zero_length"]}
                           for r in p["audio_refs"]]} for p in model["points"]]

    return {"left_sha256": a["sha256"], "right_sha256": b["sha256"],
            "bytes_identical": left == right,
            "identity_equal": a["identity"] == b["identity"],
            "ordinary_playback_equal": playback(a) == playback(b),
            "point_count_left": a["point_count"], "point_count_right": b["point_count"],
            "t6_pen_test": "not_performed"}


def audit_bnl(data, source_name=""):
    require(len(data) >= 0x204, "BNL 文件过短")
    first, second = struct.unpack_from("<II", data)
    known_old_signature = first ^ second == 0x200
    sequences = []
    # 只记录可复核的明文字节序列；明确不把它认定为完整音频目录。
    for offset in range(0x200, min(len(data), 0x20000) - 12, 2):
        n, one, two = struct.unpack_from("<III", data, offset)
        if 2 <= n <= 100000 and one == 1 and two == 2 and offset + 4 + 4 * n <= len(data):
            if all(u32(data, offset + 4 + 4 * i) == i + 1 for i in range(n)):
                sequences.append({"offset": offset, "declared_count": n,
                                  "first": 1, "last": n, "meaning": "unconfirmed"})
    return {
        "tool_version": VERSION, "source": source_name, "file_size": len(data), "sha256": sha256(data),
        "format": "BNL variant unresolved", "header_first_64_hex": data[:64].hex(),
        "old_albi_signature": known_old_signature, "first_two_words_xor": hex(first ^ second),
        "clear_integer_sequences": sequences,
        "extraction_complete": False, "conversion_ready": False,
        "blockers": ["尚未验证当前 BNL 变体的目录和指令解码规则", "尚未完整还原当前 BNL 的全部原声",
                     "尚未建立当前 BNL 点位、模式、连续播放及静音的完整账本",
                     "尚未确定 Z1279 的目标入口及资源身份关联规则"],
        "t6_pen_test": "not_performed",
    }


def save_json(path, value):
    path = Path(path)
    # 排他创建；既不覆盖历史，也不把半成品伪装成最终 NOB。
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["inspect-nob", "rebuild-nob", "compare-nob", "audit-bnl", "convert"])
    parser.add_argument("source", type=Path)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--extract-audio", type=Path)
    parser.add_argument("--output", type=Path, help="仅 rebuild-nob 支持，另存 NOB")
    parser.add_argument("--against", type=Path, help="compare-nob 的第二个文件")
    args = parser.parse_args()
    require(args.source.resolve() != args.report.resolve(), "报告路径不能与源文件相同")
    require(not args.report.exists(), "报告已存在，请使用新的输出路径")
    require(args.extract_audio is None or args.command == "inspect-nob", "此命令不接受 --extract-audio")
    require(args.output is None or args.command == "rebuild-nob", "此命令不接受 --output")
    require(args.against is None or args.command == "compare-nob", "此命令不接受 --against")
    data = args.source.read_bytes()
    if args.command == "rebuild-nob":
        require(args.output is not None, "rebuild-nob 需要 --output")
        require(not args.output.exists(), "输出已存在，请使用新的路径")
        require(args.output.resolve() != args.report.resolve(), "输出与报告不能使用相同路径")
        rebuilt = rebuild_reference(data)
        result = compare_nob(data, rebuilt)
        require(result["identity_equal"] and result["ordinary_playback_equal"], "重建后逐项比较失败")
        # 仅重建现有 NOB；不分配新书身份，不把此结果作为 BNL 转换成功证据。
        with args.output.open("xb") as output:
            output.write(rebuilt)
        save_json(args.report, result)
        print("NOB 重建并逐项复核完成；仅验证格式，T6 笔测未执行。")
        return 0
    if args.command == "compare-nob":
        require(args.against is not None, "compare-nob 需要 --against")
        result = compare_nob(data, args.against.read_bytes())
        save_json(args.report, result)
        return 0 if result["ordinary_playback_equal"] and result["identity_equal"] else 3
    if args.command == "inspect-nob":
        require(args.extract_audio is None or not args.extract_audio.exists(), "音频输出目录已存在")
        model = inspect_nob(data, str(args.source.resolve()), keep_audio=bool(args.extract_audio))
        if args.extract_audio:
            args.extract_audio.mkdir(parents=True)
            for audio in model["audios"]:
                payload = audio.pop("data")
                (args.extract_audio / (audio["id"] + ".mp3")).write_bytes(payload)
        save_json(args.report, model)
        print(f"已核对 {model['point_count']} 个点位、{model['unique_audio_count']} 个音频；笔测未执行。")
        return 0
    model = audit_bnl(data, str(args.source.resolve()))
    save_json(args.report, model)
    if args.command == "convert":
        print("UNSUPPORTED_BNL_VARIANT：旧研究入口不执行 BNL 转换；请使用 bnl_to_nob.py convert。未生成 NOB。", file=sys.stderr)
        return 2
    print("BNL 证据检查已完成；内容提取和转换尚未完成。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (FormatError, OSError, struct.error, UnicodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
