# model/

把訓練好的 TensorFlow.js 模型放在這裡，app 會自動載入：

```
model/model.json          tensorflowjs_converter 產生
model/group1-shard1of1.bin
model/meta.json           {"inputs": ["logMel"] 或 ["logMel","motionSeries"], "labels": ["agonal","normal","none"]}
```

輸入規格（見 `js/detect/model.js`）：
- `logMel`：64 mel × 96 frames（16 kHz、hop 512、約 3 秒），z-score，shape `[1, 64, 96, 1]`
- `motionSeries`：20 Hz 胸口位移序列 200 點（10 秒），z-score，shape `[1, 200, 1]`

輸出：softmax `[agonal, normal, none]`。

沒有模型時 app 使用啟發式判斷（影像 + 聲音規則），功能不受影響。訓練流程見 `docs/AI_MODEL_PLAN.md` 與 `tools/train/`。
