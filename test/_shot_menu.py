import ctypes, time, os
from ctypes import wintypes
from PIL import ImageGrab
try: ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception: pass
u = ctypes.windll.user32
HERE = os.path.dirname(os.path.abspath(__file__))
PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
found = []
def cb(h, l):
    if u.IsWindowVisible(h):
        c = ctypes.create_unicode_buffer(256); u.GetClassNameW(h, c, 256)
        if c.value == 'Chrome_WidgetWin_1':
            n = u.GetWindowTextLengthW(h)
            if n:
                b = ctypes.create_unicode_buffer(n+1); u.GetWindowTextW(h, b, n+1)
                if 'SiYuan' in b.value: found.append(h)
    return True
u.EnumWindows(PROC(cb), 0)
h = found[0]
r = wintypes.RECT(); u.GetWindowRect(h, ctypes.byref(r))
orig = (r.left, r.top, r.right, r.bottom)
u.ShowWindow(h, 9); u.MoveWindow(h, 80, 60, 1560, 980, True); u.SetForegroundWindow(h)
time.sleep(0.8)
img = ImageGrab.grab(bbox=(80, 60, 1640, 1040), all_screens=True)
px = img.convert('RGB').load(); W, H = img.size
pts = [(x, y) for y in range(0, 60) for x in range(700, W)
       if abs(px[x, y][0]-38) < 26 and abs(px[x, y][1]-86) < 26 and abs(px[x, y][2]-168) < 30]
xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
bx, by = (min(xs)+max(xs))//2, (min(ys)+max(ys))//2
u.SetCursorPos(80+bx, 60+by); time.sleep(0.2)
u.mouse_event(0x0002,0,0,0,0); time.sleep(0.12); u.mouse_event(0x0004,0,0,0,0)
time.sleep(2.2)
ImageGrab.grab(bbox=(80, 60, 1640, 1040), all_screens=True).save(os.path.join(HERE, 'menu_stats.png'))
u.keybd_event(0x1B, 0, 0, 0); u.keybd_event(0x1B, 0, 2, 0)
time.sleep(0.3)
u.MoveWindow(h, orig[0], orig[1], orig[2]-orig[0], orig[3]-orig[1], True)
print('icon', bx, by, 'shot ok, window restored')
