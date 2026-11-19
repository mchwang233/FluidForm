"""Run: python3 docs/images/art.py. Generates docs/images/banner.svg and team(.zh-CN).svg in the app's own look: warm white, hairlines,
near-black text, one green; a dark version through prefers-color-scheme."""
from pathlib import Path
from xml.sax.saxutils import escape

OUT = Path(__file__).resolve().parent

STYLE = """
    .bg { fill: #fbfaf8; } .frame { fill: none; stroke: #e8e6e1; }
    .card { fill: #ffffff; stroke: #e6e3de; } .card.lead { stroke: #1d1d1f; stroke-width: 1.6; }
    .ink { fill: #1d1d1f; } .muted { fill: #6e6e73; } .faint { fill: #a1a1a6; }
    .ring { fill: none; stroke: #1d1d1f; }
    .avatar { fill: #f1efea; } .avatar.lead { fill: #1d1d1f; } .glyph { fill: #3a3a3c; } .glyph.lead { fill: #ffffff; }
    .line { fill: none; stroke: #cfccc6; stroke-width: 1.3; } .dash { stroke-dasharray: 4 5; }
    .dot { fill: #cfccc6; } .ok { fill: #1f9d55; } .okline { stroke: #1f9d55; }
    .pill { fill: #fbfaf8; } .chip { fill: #f4f2ee; stroke: #e6e3de; } .chip.run { fill: #ffffff; stroke: #1d1d1f; }
    .group { fill: #f6f4f0; stroke: #ebe8e3; }
    .t { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
    .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0f0f10; } .frame { stroke: #232326; }
      .card { fill: #18181a; stroke: #2a2a2e; } .card.lead { stroke: #ededed; }
      .ink { fill: #ededed; } .muted { fill: #a1a1a6; } .faint { fill: #6e6e73; }
      .ring { stroke: #ededed; }
      .avatar { fill: #26262a; } .avatar.lead { fill: #ededed; } .glyph { fill: #d1d1d6; } .glyph.lead { fill: #111113; }
      .line { stroke: #3a3a3f; } .dot { fill: #3a3a3f; } .ok { fill: #3ccb7f; } .okline { stroke: #3ccb7f; }
      .pill { fill: #0f0f10; } .chip { fill: #1d1d20; stroke: #2e2e33; } .chip.run { fill: #18181a; stroke: #ededed; }
      .group { fill: #141416; stroke: #222225; }
    }
"""


def svg(width, height, label, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" '
            f'role="img" aria-label="{escape(label)}">\n  <style>{STYLE}  </style>\n'
            f'  <rect class="bg frame" x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="20"/>\n{body}</svg>\n')


def text(x, y, value, cls, size, weight=400, anchor="start", extra=""):
    return (f'  <text x="{x}" y="{y}" class="t {cls}" font-size="{size}" font-weight="{weight}" '
            f'text-anchor="{anchor}"{extra}>{escape(value)}</text>\n')


def mark(x, y, size, width):
    """The app's mark, a drop of water (frontend/icons.tsx BrandMark), centred on (x, y)."""
    k = size / 26
    return (f'  <g class="ring" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round" '
            f'transform="translate({x - 13 * k} {y - 13 * k}) scale({k})">'
            f'<path d="M13 2.8C13 2.8 5.5 11 5.5 16.2a7.5 7.5 0 0 0 15 0C20.5 11 13 2.8 13 2.8Z" stroke-width="{width / k}"/>'
            f'<path d="M9.6 16.8a3.4 3.4 0 0 0 3.2 3" stroke-width="{width / k}"/></g>\n')


# ---- banner ----
def banner():
    b = mark(90, 114, 64, 3.2)
    b += text(136, 136, "FluidForm", "ink", 52, 650)
    b += text(64, 204, "像水一样，随任务成形，把事办成。", "ink", 22, 500)
    b += text(64, 238, "Like water, it takes the shape of each task, and gets it done.", "muted", 17)
    b += (f'  <text x="64" y="282" class="mono faint" font-size="14" letter-spacing="0.5">'
          f'plan → route → run → review → repair → learn</text>\n')
    # A small plan: two steps done, one running, two waiting.
    nodes = [(812, 104, "调研", "done"), (812, 190, "看代码", "done"), (968, 147, "实现", "run"),
             (1124, 104, "验收", "wait"), (1124, 190, "测试", "wait")]
    edges = [((878, 104), (968, 147)), ((878, 190), (968, 147)), ((1034, 147), (1124, 104)), ((1034, 147), (1124, 190))]
    for (x1, y1), (x2, y2) in edges:
        mid = (x1 + x2) / 2
        b += f'  <path class="line" d="M{x1} {y1} C {mid} {y1}, {mid} {y2}, {x2} {y2}"/>\n'
    for x, y, label, state in nodes:
        cls = "chip run" if state == "run" else "chip"
        b += f'  <rect class="{cls}" x="{x - 66}" y="{y - 21}" width="132" height="42" rx="21"/>\n'
        if state == "done":
            b += f'  <circle class="ok" cx="{x - 44}" cy="{y}" r="5"/>\n'
        elif state == "run":
            b += (f'  <circle class="ok" cx="{x - 44}" cy="{y}" r="5"/>'
                  f'<circle cx="{x - 44}" cy="{y}" r="9" fill="none" class="okline" stroke-opacity=".35" stroke-width="1.5"/>\n')
        else:
            b += f'  <circle class="dot" cx="{x - 44}" cy="{y}" r="4.5"/>\n'
        b += text(x - 28, y + 5, label, "faint" if state == "wait" else "ink", 15, 500)
    b += text(968, 262, "每一步交给够用且最便宜的模型", "faint", 13, 400, "middle")
    (OUT / "banner.svg").write_text(svg(1280, 320, "FluidForm：像水一样随任务成形的多模型执行团队", b))


# ---- team ----
TEAM = {
    "zh": {
        "file": "team.zh-CN.svg", "label": "FluidForm 的团队：你、负责人、员工、验收者、进度检查员、诊断员、平台工程师、复盘员",
        "inside": "一个任务内", "ask": "提问 · 回答 · 确认", "retro_edge": "复盘结束的任务", "eng_edge": "拉进对话 · 请求组件",
        "cards": {
            "retro": ("盘", "复盘员", ["任务结束后总结经验，把有证据的", "改进交给之后的任务或平台工程师"]),
            "you": ("你", "你", ["描述任务、确认预算、回答提问"]),
            "eng": ("工", "平台工程师", ["修改 FluidForm 本身：修缺陷、加组件，", "在隔离副本里改，测过才生效"]),
            "lead": ("负", "负责人", ["规划任务，每次失败后决定怎么办，最后检查整体结果。", "同一个对话从规划一直保留到任务结束。"]),
            "w1": ("员", "员工", ["在沙箱里用工具完成自己的步骤，", "发现新的子任务可以委派给同事"]),
            "w2": ("验", "验收者", ["由另一个模型担任，按验收标准", "检查每次结果，给出意见和证据"]),
            "w3": ("查", "进度检查员", ["每 10 分钟看一眼长时间运行的", "步骤，只叫停真正卡住的"]),
            "w4": ("诊", "诊断员", ["查任务之外的障碍：缺软件、", "权限、许可证、网络，并修好环境"]),
        },
    },
    "en": {
        "file": "team.svg", "label": "The FluidForm team: you, the lead, workers, reviewer, progress checker, diagnostician, platform engineer, retrospective",
        "inside": "Inside one task", "ask": "questions · answers · approval", "retro_edge": "looks back on tasks",
        "eng_edge": "joins chats · builds parts",
        "cards": {
            "retro": ("R", "Retrospective", ["After a task ends, turns evidence", "into lessons for later tasks"]),
            "you": ("U", "You", ["Describe the task, approve the budget"]),
            "eng": ("E", "Platform engineer", ["Changes FluidForm itself: fixes", "bugs, adds components, tested first"]),
            "lead": ("L", "The lead", ["Plans the task, decides after every failure, checks", "the whole result. One conversation, start to end."]),
            "w1": ("W", "Workers", ["Do their steps with tools in a", "sandbox; can hand off new subtasks"]),
            "w2": ("R", "Reviewer", ["A different model checks each", "result against its acceptance criteria"]),
            "w3": ("P", "Progress checker", ["Looks in on long steps every 10", "minutes, stops only the stuck ones"]),
            "w4": ("D", "Diagnostician", ["Finds what blocks a step outside", "the task (tools, licenses) and fixes it"]),
        },
    },
}

BOXES = {"retro": (48, 36, 316, 116), "you": (482, 44, 316, 92), "eng": (916, 36, 316, 116),
         "lead": (420, 214, 440, 124), "w1": (64, 414, 272, 118), "w2": (356, 414, 272, 118),
         "w3": (648, 414, 272, 118), "w4": (940, 414, 272, 118)}


def card(key, glyph, name, lines):
    x, y, w, h = BOXES[key]
    lead = key == "lead"
    c = f'  <rect class="card{" lead" if lead else ""}" x="{x}" y="{y}" width="{w}" height="{h}" rx="14"/>\n'
    c += f'  <circle class="avatar{" lead" if lead else ""}" cx="{x + 36}" cy="{y + 36}" r="17"/>\n'
    c += text(x + 36, y + 41.5, glyph, "glyph lead" if lead else "glyph", 15, 600, "middle")
    c += text(x + 64, y + 42, name, "ink", 19 if lead else 17, 650)
    for n, line in enumerate(lines):
        c += text(x + 20, y + 76 + n * 22, line, "muted", 14)
    return c


def team(lang):
    data = TEAM[lang]
    t = f'  <rect class="group" x="32" y="186" width="1216" height="370" rx="18"/>\n'
    t += text(56, 214, data["inside"], "faint", 13, 500)
    # you ↔ lead
    t += '  <path class="line" d="M640 136 L640 214"/>\n'
    t += f'  <circle class="dot" cx="640" cy="136" r="3"/><circle class="dot" cx="640" cy="214" r="3"/>\n'
    t += text(654, 180, data["ask"], "faint", 12.5)
    # retrospective → lead, engineer ↔ lead
    t += '  <path class="line dash" d="M206 152 C 206 230, 330 276, 420 276"/>\n'
    t += '  <path class="line dash" d="M1074 152 C 1074 230, 950 276, 860 276"/>\n'
    t += text(222, 182, data["retro_edge"], "faint", 12.5)
    t += text(1058, 182, data["eng_edge"], "faint", 12.5, 400, "end")
    # lead → the four in the task
    for x in (200, 492, 784, 1076):
        t += f'  <path class="line" d="M640 338 C 640 380, {x} 372, {x} 414"/>\n'
    t += '  <circle class="dot" cx="640" cy="338" r="3"/>\n'
    for key, (glyph, name, lines) in data["cards"].items():
        t += card(key, glyph, name, lines)
    (OUT / data["file"]).write_text(svg(1280, 588, data["label"], t))


banner()
team("zh")
team("en")
print("ok")
