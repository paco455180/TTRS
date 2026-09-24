#!/usr/bin/env python3
"""
train_audio.py — 瀕死呼吸聲音分類模型（Keras）訓練範本

資料夾結構：
  data/audio/agonal/*.wav   瀕死呼吸（正樣本）
  data/audio/normal/*.wav   正常呼吸
  data/audio/none/*.wav     沒有呼吸（安靜、環境）
  data/audio/noise/*.wav    干擾（說話、哭喊、交通、打鼾）→ 訓練時併入 none 類

用法：
  pip install tensorflow tensorflowjs librosa numpy scikit-learn
  python tools/train/train_audio.py --data data/audio --out build/audio_model --epochs 30
  tensorflowjs_converter --input_format keras build/audio_model/model.h5 model/
  echo '{"inputs":["logMel"],"labels":["agonal","normal","none"]}' > model/meta.json

輸出：model.h5、confusion.txt、metrics.json。
注意：以「人」為單位切分資料集（檔名前綴 subjectID_xxx.wav），避免同一人洩漏到驗證集。
"""
import argparse
import glob
import json
import os
import random

import numpy as np

SR = 16000
N_MELS = 64
N_FRAMES = 96  # 約 3 秒（hop 512）
HOP = 512
LABELS = ['agonal', 'normal', 'none']
FOLDER_TO_LABEL = {'agonal': 0, 'normal': 1, 'none': 2, 'noise': 2}


def load_wav(path):
    import librosa

    y, _ = librosa.load(path, sr=SR, mono=True)
    return y


def log_mel(y):
    import librosa

    need = HOP * (N_FRAMES - 1) + 2048
    if len(y) < need:
        y = np.pad(y, (0, need - len(y)))
    m = librosa.feature.melspectrogram(y=y[:need], sr=SR, n_fft=2048, hop_length=HOP, n_mels=N_MELS, fmin=50, fmax=6000)
    m = np.log(m + 1e-6)[:, :N_FRAMES]
    m = (m - m.mean()) / (m.std() + 1e-6)
    return m.astype(np.float32)


def augment(y, rng):
    """簡單增強：音量、時間伸縮、加噪、隨機偏移。"""
    import librosa

    if rng.random() < 0.8:
        y = y * rng.uniform(0.5, 1.6)
    if rng.random() < 0.5:
        y = librosa.effects.time_stretch(y, rate=rng.uniform(0.9, 1.1))
    if rng.random() < 0.7:
        snr_db = rng.uniform(0, 20)
        noise = rng.standard_normal(len(y)).astype(np.float32)
        y = y + noise * (np.sqrt(np.mean(y ** 2)) / (10 ** (snr_db / 20)) + 1e-6)
    if rng.random() < 0.5:
        shift = int(rng.uniform(0, 0.5 * SR))
        y = np.roll(y, shift)
    return y


def subject_of(path):
    return os.path.basename(path).split('_')[0]


def build_model():
    import tensorflow as tf

    L = tf.keras.layers
    inp = L.Input(shape=(N_MELS, N_FRAMES, 1), name='logMel')
    x = inp
    for f in (16, 32, 64, 128):
        x = L.SeparableConv2D(f, 3, padding='same', activation='relu')(x)
        x = L.BatchNormalization()(x)
        x = L.MaxPool2D(2)(x)
    x = L.GlobalAveragePooling2D()(x)
    x = L.Dropout(0.3)(x)
    out = L.Dense(len(LABELS), activation='softmax')(x)
    model = tf.keras.Model(inp, out)
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss='sparse_categorical_crossentropy', metrics=['accuracy'])
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--aug', type=int, default=4, help='每個檔案增強幾份')
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    random.seed(args.seed)

    files = []
    for folder, label in FOLDER_TO_LABEL.items():
        for p in glob.glob(os.path.join(args.data, folder, '*.wav')):
            files.append((p, label))
    if not files:
        raise SystemExit('找不到 wav 檔')

    subjects = sorted({subject_of(p) for p, _ in files})
    random.shuffle(subjects)
    n_val = max(1, len(subjects) // 5)
    val_subjects = set(subjects[:n_val])
    train = [(p, l) for p, l in files if subject_of(p) not in val_subjects]
    val = [(p, l) for p, l in files if subject_of(p) in val_subjects]
    print(f'train {len(train)} files / val {len(val)} files / subjects {len(subjects)}')

    def featurize(items, aug_n):
        X, Y = [], []
        for p, l in items:
            y = load_wav(p)
            X.append(log_mel(y))
            Y.append(l)
            for _ in range(aug_n):
                X.append(log_mel(augment(y, rng)))
                Y.append(l)
        return np.stack(X)[..., None], np.array(Y)

    Xtr, Ytr = featurize(train, args.aug)
    Xva, Yva = featurize(val, 0)

    import tensorflow as tf

    model = build_model()
    model.summary()
    # 類別權重：正樣本少，且漏掉 agonal 的代價高
    counts = np.bincount(Ytr, minlength=len(LABELS))
    cw = {i: float(len(Ytr) / (len(LABELS) * max(1, c))) for i, c in enumerate(counts)}
    cw[0] *= 2.0
    cb = [tf.keras.callbacks.EarlyStopping(patience=6, restore_best_weights=True, monitor='val_loss')]
    model.fit(Xtr, Ytr, validation_data=(Xva, Yva), epochs=args.epochs, batch_size=32, class_weight=cw, callbacks=cb)

    os.makedirs(args.out, exist_ok=True)
    model.save(os.path.join(args.out, 'model.h5'))

    from sklearn.metrics import confusion_matrix, classification_report

    pred = model.predict(Xva).argmax(1)
    cm = confusion_matrix(Yva, pred, labels=list(range(len(LABELS))))
    report = classification_report(Yva, pred, target_names=LABELS, output_dict=True)
    # 「需要 CPR」(agonal+none) 的敏感度
    need = np.isin(Yva, [0, 2])
    sens = float(np.mean(np.isin(pred[need], [0, 2]))) if need.any() else float('nan')
    with open(os.path.join(args.out, 'confusion.txt'), 'w') as f:
        f.write('labels: ' + ' '.join(LABELS) + '\n' + str(cm) + '\n')
    with open(os.path.join(args.out, 'metrics.json'), 'w') as f:
        json.dump({'report': report, 'need_cpr_sensitivity': sens}, f, indent=2, ensure_ascii=False)
    print(cm)
    print('need-CPR sensitivity:', sens)


if __name__ == '__main__':
    main()
