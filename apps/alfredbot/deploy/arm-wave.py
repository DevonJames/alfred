# Pi-side BLE arm wave. The iPhone never pairs with the arm — AlfredBot
# runs this on the robot, same as alfred-home `arm_wave.py` / `alfred armWave`.
#
# LewanSoul bus (500–2500 µs ticks, ~1500 center). Not the PCA9685 head.
#   1 gripper
#   2 wrist rotate
#   3 wrist tilt (wave)
#   4 elbow
#   5 shoulder lift  — raise SHOULDER_WAVE_UP for a bigger lift
#   6 base / shoulder yaw
import asyncio
from bleak import BleakClient
import asyncio.subprocess

ADDRESS = '48:87:2D:7F:D8:23'
TILT_HAT_SCRIPT = '/home/alfred/tilt_hat.py'
TILT_HAT_DELAY_S = 2.0

GRIPPER, WRIST_ROT, WRIST_TILT, ELBOW, SHOULDER, BASE = 1, 2, 3, 4, 5, 6

# Native reset (script comments + rest pose).
RESET = {
    GRIPPER: 770,
    WRIST_ROT: 1500,
    WRIST_TILT: 644,
    ELBOW: 511,
    SHOULDER: 1255,
    BASE: 1500,
}
# Base yaw: 1500 center, 500 ≈ 90° right on this rig.
BASE_WAVE_RIGHT = 500
# Shoulder lift during the wave pose. Rest is 1255; 1833 ≈ 30° up.
# Higher = more up (toward 2500).
SHOULDER_WAVE_UP = 1833
WAVE_LIFT = {
    WRIST_ROT: 2500,  # 90° CW
    WRIST_TILT: 2500,  # max up
    ELBOW: 1000,  # bent deeply
    SHOULDER: SHOULDER_WAVE_UP,
}
WRIST_WAVE_DOWN = 2200
WRIST_WAVE_UP = 2500

def move_multiple_servos(duration, servos):
    length = len(servos) * 3 + 5
    packet = [0x55, 0x55, length, 0x03, len(servos), duration & 0xFF, (duration >> 8) & 0xFF]
    for s_id, pos in servos.items():
        packet.extend([s_id, pos & 0xFF, (pos >> 8) & 0xFF])
    return bytes(packet)

def move_servo(servo_id, position, duration):
    t_l = duration & 0xFF
    t_h = (duration >> 8) & 0xFF
    p_l = position & 0xFF
    p_h = (position >> 8) & 0xFF
    packet = [0x55, 0x55, 0x08, 0x03, 0x01, t_l, t_h, servo_id, p_l, p_h]
    return bytes(packet)

async def run():
    try:
        async with BleakClient(ADDRESS) as client:
            target_char = None
            for service in client.services:
                if 'ffe0' in service.uuid.lower():
                    for char in service.characteristics:
                        if 'ffe1' in char.uuid.lower():
                            target_char = char
                            break
            if target_char:
                async def run_tilt_hat_delayed():
                    await asyncio.sleep(TILT_HAT_DELAY_S)
                    try:
                        print('Launching delayed hat-tilt...')
                        proc = await asyncio.create_subprocess_exec(
                            "python3", TILT_HAT_SCRIPT,
                        )
                        await proc.wait()
                        print(f'Delayed hat-tilt finished (rc={proc.returncode})')
                    except Exception as exc:
                        print(f'Hat-tilt delayed launch failed: {exc}')

                # Start hat-tilt timer immediately so it runs ~2s after the
                # arm-wave command starts, not after the full wave finishes.
                tilt_task = asyncio.create_task(run_tilt_hat_delayed())

                # 1. Start in Native Reset Position
                print('Starting from Native Reset Position...')
                cmd = move_multiple_servos(1500, RESET)
                await client.write_gatt_char(target_char, cmd, response=False)
                await asyncio.sleep(2.0)
                
                # 2. Rotate base 90° to the right first (servo 6).
                print('Rotating shoulder/base 90deg to the right...')
                cmd = move_servo(BASE, BASE_WAVE_RIGHT, 1200)
                await client.write_gatt_char(target_char, cmd, response=False)
                await asyncio.sleep(1.5)

                # 3. Lift arm (servo 5 = shoulder). Base stays at BASE_WAVE_RIGHT.
                print('Lifting arm into position...')
                cmd = move_multiple_servos(1500, WAVE_LIFT)
                await client.write_gatt_char(target_char, cmd, response=False)
                await asyncio.sleep(2.0)
                
                # 4. Three wrist-tilt waves (servo 3).
                print('Waving!')
                for _ in range(3):
                    cmd = move_servo(WRIST_TILT, WRIST_WAVE_DOWN, 200)
                    await client.write_gatt_char(target_char, cmd, response=False)
                    await asyncio.sleep(0.25)
                    cmd = move_servo(WRIST_TILT, WRIST_WAVE_UP, 200)
                    await client.write_gatt_char(target_char, cmd, response=False)
                    await asyncio.sleep(0.25)
                
                # Settle for a moment
                await asyncio.sleep(1.0)
                
                # 5. Return gracefully to Native Reset
                print('Returning to Native Reset...')
                cmd = move_multiple_servos(1500, RESET)
                await client.write_gatt_char(target_char, cmd, response=False)
                await asyncio.sleep(2.0)
                
                # Ensure delayed hat-tilt task has had a chance to finish.
                try:
                    await tilt_task
                except Exception as exc:
                    print(f'Hat-tilt task join failed: {exc}')

                print('Done.')
    except Exception as e:
        print('Error:', e)

asyncio.run(run())
