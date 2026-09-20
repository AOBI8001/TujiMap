import { useEffect, useRef, useState } from "react";
import { cityById, type CityId, type Spot } from "./data";
import type { ImageTripRequest, ImportedTrip } from "./ImageImport";

type Match = {
  name: string;
  day: number | null;
  choices: Spot[];
  chosen: string;
  include: boolean;
  error: string;
};
export function chooseImagePlace(
  name: string,
  choices: Spot[],
  cityName: string,
): Spot | undefined {
  const exact = choices.filter((spot) => spot.name === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  // 只折叠常见后缀；保留门、售票处、停车场等实际地理区别。
  const normalize = (value: string) =>
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s/g, "")
      .replace(new RegExp(`^${cityName}市?`), "")
      .replace(/国家重点风景名胜区|风景名胜区|历史文化街区|风景区|景区/g, "")
      .replace(/国际文化艺术中心/g, "艺术中心");
  const matching = choices.filter(
    (spot) => normalize(spot.name) === normalize(name),
  );
  return matching.length === 1 ? matching[0] : undefined;
}
export function ImagePlanResolver({
  request,
  resolve,
  onComplete,
  onCancel,
}: {
  request: ImageTripRequest;
  resolve: (city: CityId, name: string) => Promise<Spot[]>;
  onComplete: (trip: ImportedTrip) => Promise<void>;
  onCancel: () => void;
}) {
  const [matches, setMatches] = useState<Match[]>([]);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<"matching" | "review" | "entering">(
    "matching",
  );
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const latest = useRef({ resolve, onComplete });
  latest.current = { resolve, onComplete };
  const pending = useRef(false);
  const finish = async (items: Match[]) => {
    if (pending.current) return;
    pending.current = true;
    setPhase("entering");
    setError("");
    const spots = new Map<string, Spot>(),
      locks: Record<string, number> = {};
    for (const item of items.filter((item) => item.include)) {
      const spot = item.choices.find((spot) => spot.id === item.chosen);
      if (!spot) {
        pending.current = false;
        setPhase("review");
        return;
      }
      spots.set(spot.id, spot);
      if (item.day) locks[spot.id] = item.day;
    }
    try {
      await latest.current.onComplete({
        cityId: request.cityId,
        days: request.days,
        spots: [...spots.values()],
        locks,
      });
    } catch {
      setError("城市数据暂未加载成功，请重试");
      setPhase("review");
    } finally {
      pending.current = false;
    }
  };
  useEffect(() => {
    let active = true;
    const rows: Match[] = request.places.map((place) => ({
      ...place,
      choices: [],
      chosen: "",
      include: true,
      error: "",
    }));
    let cursor = 0,
      done = 0;
    setPhase("matching");
    setError("");
    setProgress(0);
    void Promise.all(
      Array.from({ length: 2 }, async () => {
        while (active && cursor < rows.length) {
          const index = cursor++;
          try {
            const choices = await latest.current.resolve(
              request.cityId,
              rows[index].name,
            );
            const chosen = chooseImagePlace(
              rows[index].name,
              choices,
              cityById(request.cityId).name,
            );
            rows[index] = {
              ...rows[index],
              choices,
              chosen: chosen?.id || "",
              error: choices.length
                ? "请选择正确地点"
                : "未找到这个地点，可取消勾选",
            };
          } catch {
            rows[index].error = "搜索暂不可用，可重试";
          }
          if (active) {
            setMatches([...rows]);
            setProgress(++done);
          }
        }
      }),
    ).then(() => {
      if (!active) return;
      if (rows.every((row) => !!row.chosen)) void finish(rows);
      else setPhase("review");
    });
    return () => {
      active = false;
    };
  }, [request, revision]);
  const unresolved = matches.filter((item) => !item.chosen);
  const ready =
    matches.some((item) => item.include) &&
    matches.every((item) => !item.include || !!item.chosen);
  return (
    <div className="image-plan-overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="图片路线规划"
        className="image-plan-dialog"
      >
        <h2>
          {phase === "review" ? "这几个地点需要确认" : "正在生成你的路线"}
        </h2>
        {phase !== "review" ? (
          <>
            <div className="image-plan-wave" />
            <p role="status">
              {phase === "matching"
                ? `正在定位地点 ${progress} / ${request.places.length}`
                : "正在安排每天的路线…"}
            </p>
            <button
              className="image-plan-cancel"
              disabled={phase === "entering"}
              onClick={onCancel}
            >
              返回修改
            </button>
          </>
        ) : (
          <>
            <div className="image-plan-issues">
              {unresolved.map((row) => {
                const index = matches.indexOf(row);
                return (
                  <div key={index}>
                    <label>
                      <input
                        type="checkbox"
                        checked={row.include}
                        onChange={(event) =>
                          setMatches((current) =>
                            current.map((item, i) =>
                              i === index
                                ? { ...item, include: event.target.checked }
                                : item,
                            ),
                          )
                        }
                      />
                      {row.name}
                    </label>
                    {row.include && (
                      <>
                        {row.choices.length > 0 && (
                          <select
                            aria-label={`${row.name}的候选地点`}
                            value={row.chosen}
                            onChange={(event) =>
                              setMatches((current) =>
                                current.map((item, i) =>
                                  i === index
                                    ? { ...item, chosen: event.target.value }
                                    : item,
                                ),
                              )
                            }
                          >
                            <option value="">请选择地点和地址</option>
                            {row.choices.map((spot) => (
                              <option key={spot.id} value={spot.id}>
                                {spot.name} · {spot.address || spot.area}
                              </option>
                            ))}
                          </select>
                        )}
                        <small>{row.error}</small>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {error && <p role="alert">{error}</p>}
            <div className="image-plan-buttons">
              <button onClick={onCancel}>返回修改</button>
              <button onClick={() => setRevision((value) => value + 1)}>
                重试定位
              </button>
              <button disabled={!ready} onClick={() => void finish(matches)}>
                继续规划
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
