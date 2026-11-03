"""
真机 UI 端到端：点顶栏图标 → 截图菜单 → 点「一键导出全部附件」→ 截图结果。
全程自动把思源窗口挪到主屏、按完再挪回原位置。

用法（必须用带 PIL 的解释器）：
  "C:/Users/<用户>/.workbuddy/binaries/python/envs/default/Scripts/python.exe" test/ui_e2e.py

定位靠颜色：顶栏图标 #2656a8，菜单里导出项的图标 #1f8a5b。
第一次点击只会激活窗口，所以点图标前先空点一下编辑器区域。
"""
import ctypes, time, sys, os, glob
from ctypes import wintypes
from PIL import ImageGrab

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    pass

u = ctypes.windll.user32
HERE = os.path.dirname(os.path.abspath(__file__))


def find_siyuan():
    out = []
    PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def cb(h, l):
        if u.IsWindowVisible(h):
            cls = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(h, cls, 256)
            if cls.value == 'Chrome_WidgetWin_1':
                n = u.GetWindowTextLengthW(h)
                if n:
                    b = ctypes.create_unicode_buffer(n + 1)
                    u.GetWindowTextW(h, b, n + 1)
                    if 'SiYuan' in b.value:
                        out.append((h, b.value))
        return True

    u.EnumWindows(PROC(cb), 0)
    return out[0] if out else (None, None)


hwnd, title = find_siyuan()
if not hwnd:
    print('NO Siyuan window')
    sys.exit(1)
print('window', hwnd, title)

r0 = wintypes.RECT()
u.GetWindowRect(hwnd, ctypes.byref(r0))
orig = (r0.left, r0.top, r0.right, r0.bottom)

u.ShowWindow(hwnd, 9)                      # SW_RESTORE
u.MoveWindow(hwnd, 80, 60, 1560, 980, True)
u.SetForegroundWindow(hwnd)
time.sleep(1.0)


def click(sx, sy):
    u.SetCursorPos(sx, sy)
    time.sleep(0.2)
    u.mouse_event(0x0002, 0, 0, 0, 0)
    time.sleep(0.12)
    u.mouse_event(0x0004, 0, 0, 0, 0)


def shot(name):
    r = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(r))
    img = ImageGrab.grab(bbox=(r.left, r.top, r.right, r.bottom), all_screens=True)
    img.save(os.path.join(HERE, name))
    return img, (r.left, r.top)


def findpx(img, target, tol, y0, y1, x0=0):
    px = img.convert('RGB').load()
    W, H = img.size
    pts = []
    for y in range(y0, min(y1, H)):
        for x in range(x0, W):
            r, g, b = px[x, y]
            if abs(r - target[0]) < tol and abs(g - target[1]) < tol and abs(b - target[2]) < tol:
                pts.append((x, y))
    if not pts:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs) + max(xs)) // 2, (min(ys) + max(ys)) // 2, len(pts)


def restore():
    u.MoveWindow(hwnd, orig[0], orig[1], orig[2] - orig[0], orig[3] - orig[1], True)


img, (ox, oy) = shot('e2e_0.png')
click(ox + 400, oy + 300)          # 空点编辑器，先激活窗口
time.sleep(0.5)

b = findpx(img, (38, 86, 168), 30, 0, 60, 700)
print('topbar icon at', b)
if not b:
    print('NO TOPBAR ICON')
    restore()
    sys.exit(2)

click(ox + b[0], oy + b[1])
time.sleep(1.5)

img1, _ = shot('e2e_1.png')
g = findpx(img1, (31, 138, 91), 30, 60, 700, 400)
print('menu export icon at', g)
if not g:
    print('NO MENU')
    restore()
    sys.exit(3)

click(ox + g[0] + 130, oy + g[1])
time.sleep(3.0)
shot('e2e_2.png')
restore()
print('window restored to', orig)

dirs = sorted(glob.glob(os.path.join(os.environ.get('TEMP', ''), '思源附件-*')), key=os.path.getmtime)
if dirs:
    d = dirs[-1]
    files = sorted(os.listdir(d))
    print('newest export dir:', d)
    print('files:', len(files))
    for f in files[:5]:
        print('   ', f)
else:
    print('NO EXPORT DIR')
print('done')
