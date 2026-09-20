import { useEffect, useRef, useState } from "react";
import { CITIES, type CityId, type Spot } from "./data";

export type ImportedTrip = {
  cityId: CityId;
  days: number;
  spots: Spot[];
  locks: Record<string, number>;
};
export type ImageTripRequest = {
  cityId: CityId;
  days: number;
  places: { name: string; day: number | null }[];
};
type Extracted = { name: string; day: number | null; include: boolean };
type Props = {
  cityId: CityId | null;
  days: number;
  onImport: (trip: ImageTripRequest) => Promise<void>;
};

async function prepareImage(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type))
    throw new Error("请选择 JPG、PNG 或 WebP 图片");
  if (file.size > 10 * 1024 * 1024)
    throw new Error("图片不能超过 10 MB，请裁剪后上传");
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * ratio);
    canvas.height = Math.round(bitmap.height * ratio);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前浏览器无法处理图片");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.9);
    if (data.length > 4_400_000)
      throw new Error("图片内容过多，请裁剪成较小的图片");
    return data;
  } finally {
    bitmap.close();
  }
}

export function ImageImport({
  cityId: initialCity,
  days: initialDays,
  onImport,
}: Props) {
  const [image, setImage] = useState("");
  const [cityId, setCityId] = useState<CityId | "">(initialCity || "");
  const [days, setDays] = useState(initialDays);
  const [places, setPlaces] = useState<Extracted[]>([]);
  const [recognized, setRecognized] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!recognized) {
      setCityId(initialCity || "");
      setDays(initialDays);
    }
  }, [initialCity, initialDays]);

  const chooseFile = async (file?: File) => {
    if (!file || busy) return;
    const version = ++generation.current;
    setError("");
    setBusy("正在处理图片…");
    try {
      const prepared = await prepareImage(file);
      if (version !== generation.current) return;
      setImage(prepared);
      setPlaces([]);
      setRecognized(false);
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : "图片无法读取");
    } finally {
      if (version === generation.current) setBusy("");
    }
  };
  const identify = async () => {
    const version = ++generation.current;
    setBusy("正在识别图片中的地点…");
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    const deadline = window.setTimeout(() => abort.abort(), 45000);
    try {
      const response = await fetch("/api/recognize-image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image }),
        signal: abort.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error || "识别暂不可用，请稍后重试");
      if (version !== generation.current) return;
      if (!Array.isArray(data.places) || !data.places.length)
        throw new Error("未发现明确的游览地点，请换一张清晰的攻略图片");
      const detected = CITIES.find(
        (city) =>
          city.name.replace(/市$/, "") === String(data.city).replace(/市$/, ""),
      );
      setCityId(detected?.id || "");
      if (data.days) setDays(data.days);
      setPlaces(
        data.places.map((place: { name: string; day: number | null }) => ({
          ...place,
          include: true,
        })),
      );
      setRecognized(true);
    } catch (e) {
      if (version === generation.current)
        setError(
          abort.signal.aborted
            ? "识别已超时，请裁剪图片后重试"
            : e instanceof Error
              ? e.message
              : "识别失败，请重试",
        );
    } finally {
      window.clearTimeout(deadline);
      if (version === generation.current) setBusy("");
    }
  };
  const selected = places.filter((place) => place.include);
  const confirm = async () => {
    if (!cityId || !selected.length || busy) return;
    setBusy("正在进入地图…");
    setError("");
    try {
      await onImport({
        cityId,
        days,
        places: selected.map(({ name, day }) => ({
          name,
          day: day && day <= days ? day : null,
        })),
      });
    } catch {
      setError("暂时无法进入地图，请重试");
    } finally {
      setBusy("");
    }
  };
  return (
    <div className={`image-import ${recognized ? "recognized" : ""}`}>
      <div className="import-heading">
        <h2>{recognized ? "选好地点，就出发。" : "把攻略，变成路线。"}</h2>
        {!recognized && <p>上传攻略截图或手绘地图，识别想去的地方。</p>}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        disabled={!!busy}
        onChange={(event) => {
          void chooseFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {!recognized && (
        <button
          type="button"
          className={`image-dropzone ${dragging ? "dragging" : ""} ${image ? "has-image" : ""}`}
          disabled={!!busy}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void chooseFile(event.dataTransfer.files[0]);
          }}
        >
          {image ? (
            <>
              <img src={image} alt="待识别的攻略图片" />
              <span>点击更换图片</span>
            </>
          ) : (
            <>
              <span className="upload-symbol" aria-hidden="true">
                ↑
              </span>
              <strong>点击上传，或将图片拖到这里</strong>
              <span>JPG / PNG / WebP · 单张不超过 10 MB</span>
            </>
          )}
        </button>
      )}
      {recognized && (
        <>
          <div className="import-options">
            <label>
              目的地
              <select
                aria-label="识别目的地"
                value={cityId}
                disabled={!!busy}
                onChange={(event) => setCityId(event.target.value as CityId)}
              >
                <option value="">请选择城市</option>
                {[...CITIES]
                  .sort((a, b) => a.pinyin.localeCompare(b.pinyin))
                  .map((city) => (
                    <option key={city.id} value={city.id}>
                      {city.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              旅行天数
              <select
                aria-label="识别旅行天数"
                value={days}
                disabled={!!busy}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {Array.from({ length: 7 }, (_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1} 天
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="import-list-heading">
            <strong>
              想去的地点 <span>{selected.length}</span>
            </strong>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => input.current?.click()}
            >
              更换图片
            </button>
          </div>
          <div className="import-list" aria-label="识别地点列表">
            {places.map((place, index) => (
              <label
                className={`import-check-place ${!place.include ? "excluded" : ""}`}
                key={index}
              >
                <input
                  aria-label={`选择${place.name}`}
                  type="checkbox"
                  checked={place.include}
                  disabled={!!busy}
                  onChange={(event) =>
                    setPlaces((current) =>
                      current.map((item, i) =>
                        i === index
                          ? { ...item, include: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <span>{place.name}</span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="import-footer">
        {busy && (
          <p className="import-progress" role="status">
            {busy}
          </p>
        )}
        {error && (
          <p className="import-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="import-primary"
          disabled={
            !!busy || (recognized ? !cityId || !selected.length : !image)
          }
          onClick={() => void (recognized ? confirm() : identify())}
        >
          {recognized ? "确认并规划" : "识别图片"}
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
