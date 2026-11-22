#!/usr/bin/env python3
"""
scripts/fit_calibration.py
Processes calibration_data.csv to compute:
1. Linear regression per tone: SPL = p1 * rx_fft_magnitude_db + p2
2. Exponential regression per tone: tx_gain = a * exp(b * target_rx_db)
Prints the resulting TOML calibration block ready to paste into oae_config.toml.
"""
import sys, os, csv
import numpy as np

def exp_func(x, a, b):
    return a * np.exp(b * x)

def main():
    csv_file = sys.argv[1] if len(sys.argv) > 1 else "calibration_data.csv"
    if not os.path.exists(csv_file):
        print(f"[ERROR] Cannot find CSV file '{csv_file}'")
        print("Run calibration_sweep.py first to generate the measurement data.")
        sys.exit(1)

    data = {}
    with open(csv_file, mode='r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            idx = int(row["tone_index"])
            if idx not in data:
                data[idx] = {
                    "freq": int(row["frequency_hz"]),
                    "gains": [],
                    "mags": [],
                    "spls": []
                }
            data[idx]["gains"].append(float(row["digital_gain"]))
            data[idx]["mags"].append(float(row["rx_fft_magnitude_db"]))
            data[idx]["spls"].append(float(row["measured_spl_db"]))

    p1_list = []
    p2_list = []
    a_list = []
    b_list = []

    print("\n=== Curve Fitting Results ===")
    for idx in sorted(data.keys()):
        freq = data[idx]["freq"]
        mags = np.array(data[idx]["mags"])
        spls = np.array(data[idx]["spls"])
        gains = np.array(data[idx]["gains"])

        # 1. Linear fit: SPL = p1 * mag + p2
        poly = np.polyfit(mags, spls, deg=1)
        p1 = float(poly[0])
        p2 = float(poly[1])
        p1_list.append(p1)
        p2_list.append(p2)

        # 2. Exponential fit: gain = a * exp(b * mag)
        # Using linear fit on log(gain) vs mag: log(gain) = log(a) + b * mag
        try:
            log_gains = np.log(np.maximum(1e-5, gains))
            exp_poly = np.polyfit(mags, log_gains, deg=1)
            b_val = float(exp_poly[0])
            a_val = float(np.exp(exp_poly[1]))
        except Exception:
            a_val = 1.0e-7
            b_val = 0.115

        a_list.append(a_val)
        b_list.append(b_val)

        print(f"Tone {idx} ({freq} Hz): p1={p1:.4f}, p2={p2:.2f} | a={a_val:.3e}, b={b_val:.4f}")

    print("\n# ==============================================================================")
    print("# Copy and paste this block into config/oae_config.toml:")
    print("# under [profiles.ugreen_80864_rpi5.calibration]")
    print("# ==============================================================================")
    print(f"p1 = [{', '.join(f'{x:.6f}' for x in p1_list)}]")
    print(f"p2 = [{', '.join(f'{x:.4f}' for x in p2_list)}]")
    print(f"a  = [{', '.join(f'{x:.3e}' for x in a_list)}]")
    print(f"b  = [{', '.join(f'{x:.6f}' for x in b_list)}]")
    print("# ==============================================================================\n")

if __name__ == "__main__":
    main()
