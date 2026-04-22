import os
import sys

VIDEO_EXTS = {'.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.flv', '.wmv', '.3gp', '.ts', '.mpg', '.mpeg'}
AUDIO_EXTS = {'.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.wma', '.opus', '.mid', '.midi', '.amr', '.ape'}

def get_drives():
    if sys.platform == 'win32':
        import ctypes
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
        drives = []
        for i in range(26):
            if bitmask & (1 << i):
                drives.append(f"{chr(65 + i)}:\\")
        return drives
    return ['/']

def test_scan():
    drives = get_drives()
    print(f"Found drives: {drives}")
    for drive in drives:
        print(f"Scanning {drive} (top level only for test)...")
        try:
            items = os.listdir(drive)
            found = 0
            for item in items:
                ext = os.path.splitext(item)[1].lower()
                if ext in VIDEO_EXTS or ext in AUDIO_EXTS:
                    found += 1
            print(f"Found {found} media files in root of {drive}")
        except Exception as e:
            print(f"Error accessing {drive}: {e}")

if __name__ == "__main__":
    test_scan()
