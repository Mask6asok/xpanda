import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { strToU8, zipSync, type Zippable } from "fflate";
import {
    DEFAULT_DECOMPILE_JOBS,
    DecompileService,
    MAX_DECOMPILE_JOBS,
    buildClassRefs,
    loadImage,
    yieldToUI,
    zipPathFor,
    type BulkState,
    type ClassRef,
    type DecompileMode,
    type AbcSource,
    type LoadedImage,
} from "./decompiler";
import { hashBytes } from "./cache";
import { downloadBlob, readError, sanitizeFileName, stripExt } from "./format";
import { Topbar } from "./components/Topbar";
import { NoticeBar } from "./components/NoticeBar";
import { BulkBar } from "./components/BulkBar";
import { Sidebar } from "./components/Sidebar";
import { CodePane } from "./components/CodePane";
import { ReferencePane } from "./components/ReferencePane";
import { buildXrefsInWorker, type XrefWorkerClient } from "./parallel/XrefWorker";
import type { CodeJump, CodeNavigate } from "./code-navigation";

type Phase = "idle" | "parsing" | "decompiling";

const JOBS_STORAGE_KEY = "xpanda-web.worker-jobs";

/** 读取上次选择的 worker 数;无记录 / 非法值 / localStorage 不可用时回退默认 4 */
function loadWorkerJobs(): number {
    try {
        const raw = window.localStorage.getItem(JOBS_STORAGE_KEY);
        const value = raw === null ? NaN : Number(raw);
        if (Number.isInteger(value) && value >= 1 && value <= MAX_DECOMPILE_JOBS) return value;
    } catch {
        // 隐私模式等场景下 localStorage 可能抛异常
    }
    return DEFAULT_DECOMPILE_JOBS;
}

function saveWorkerJobs(jobs: number): void {
    try {
        window.localStorage.setItem(JOBS_STORAGE_KEY, String(jobs));
    } catch {
        // 忽略写入失败:本次会话内仍然生效
    }
}

/** 窄屏(手机)断点:主区从“侧栏 + 代码”并排切换为二选一视图 */
const NARROW_MEDIA_QUERY = "(max-width: 760px)";

/** 跟踪窄屏断点;只在手机宽度下为 true,用于启用列表/代码双视图切换 */
function useIsNarrow(): boolean {
    const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(NARROW_MEDIA_QUERY).matches);
    useEffect(() => {
        const mql = window.matchMedia(NARROW_MEDIA_QUERY);
        const onChange = (e: MediaQueryListEvent): void => setIsNarrow(e.matches);
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
    }, []);
    return isNarrow;
}

/**
 * xpanda web 主界面:
 *  - 拖拽 / 点击加载 .abc / .hap(纯前端解析);
 *  - 左侧类列表(搜索 + 包分组),点击单个类反编译;
 *  - 顶部全量反编译(逐类让出主线程,可取消),完成后可打包 zip 下载。
 * @Author: jmp0
 */
export function App() {
    const serviceRef = useRef<DecompileService | null>(null);
    if (serviceRef.current === null) serviceRef.current = new DecompileService();
    const service = serviceRef.current;

    const [images, setImages] = useState<LoadedImage[]>([]);
    const [mode, setMode] = useState<DecompileMode>("simplify");
    const [selected, setSelected] = useState<ClassRef | null>(null);
    const [cacheVersion, setCacheVersion] = useState(0);
    const [phase, setPhase] = useState<Phase>("idle");
    const [error, setError] = useState<string | null>(null);
    const [bulk, setBulk] = useState<BulkState | null>(null);
    const [dragging, setDragging] = useState(false);
    /** Decompile all 使用的 worker 数(默认 4,可在工具栏切换并记住) */
    const [workerJobs, setWorkerJobs] = useState<number>(loadWorkerJobs);
    /** 窄屏下主区显示哪个视图:类列表 / 代码(宽屏下两者并排,该状态不生效) */
    const [mobileView, setMobileView] = useState<"list" | "code">("list");
    const [referencesOpen, setReferencesOpen] = useState(false);
    const [referenceSourceId, setReferenceSourceId] = useState<string | null>(null);
    const [referenceIndexes, setReferenceIndexes] = useState<Map<string, XrefWorkerClient>>(new Map());
    const referenceWorkers = useRef(new Map<string, XrefWorkerClient>());
    const [referenceBuild, setReferenceBuild] = useState<{ sourceId: string; done: number; total: number } | null>(null);
    const [referenceError, setReferenceError] = useState<{ sourceId: string; message: string } | null>(null);
    const referenceTask = useRef<{ sourceId: string; promise: Promise<XrefWorkerClient> } | null>(null);
    const [codeJump, setCodeJump] = useState<CodeJump | null>(null);
    const isNarrow = useIsNarrow();

    useEffect(() => () => {
        for (const worker of referenceWorkers.current.values()) worker.dispose();
        referenceWorkers.current.clear();
    }, []);

    const bulkCancel = useRef(false);
    const dragDepth = useRef(0);
    /** 并发解析计数:多次拖入时避免先完成的一次把 phase 提前置回 idle */
    const parsingCount = useRef(0);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const refs = useMemo(
        () => images.flatMap((img) => img.sources.flatMap((s) => buildClassRefs(s))),
        [images],
    );
    const sources = useMemo(() => images.flatMap((img) => img.sources), [images]);
    const referenceSource = sources.find((source) => source.id === referenceSourceId)
        ?? selected?.source
        ?? sources[0]
        ?? null;

    const cachedKeys = useMemo(() => {
        const set = new Set<string>();
        for (const ref of refs) {
            if (service.peek(ref, mode) !== undefined) set.add(ref.key);
        }
        return set;
        // cacheVersion 驱动缓存重算
    }, [refs, mode, cacheVersion, service]);
    const cachedCount = cachedKeys.size;
    const currentCode = selected !== null ? service.peek(selected, mode) : undefined;
    const currentElapsed = selected !== null ? service.elapsedMs(selected, mode) : undefined;

    // 当前选中的类尚未反编译(新选中或模式切换)时,后台反编译一次
    useEffect(() => {
        if (selected === null || service.peek(selected, mode) !== undefined) return;
        let alive = true;
        void (async () => {
            setPhase("decompiling");
            await yieldToUI();
            if (!alive) return;
            try {
                service.decompile(selected, mode);
            } catch (e) {
                setError(readError(e));
            }
            setPhase("idle");
            setCacheVersion((v) => v + 1);
        })();
        return () => {
            alive = false;
        };
    }, [selected, mode, cacheVersion, service]);

    // 页面卸载前把攒批中的缓存写入 IndexedDB,避免丢掉最后几个类的结果
    useEffect(() => {
        const onPageHide = (): void => {
            void service.flush();
        };
        window.addEventListener("pagehide", onPageHide);
        return () => window.removeEventListener("pagehide", onPageHide);
    }, [service]);

    // 全屏拖拽:dragenter/leave 成对计数,避免经过子元素时闪烁
    useEffect(() => {
        const hasFiles = (e: DragEvent): boolean =>
            e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes("Files");
        const onDragEnter = (e: DragEvent): void => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth.current++;
            setDragging(true);
        };
        const onDragOver = (e: DragEvent): void => {
            if (!hasFiles(e)) return;
            e.preventDefault();
        };
        const onDragLeave = (): void => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
        };
        const onDrop = (e: DragEvent): void => {
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length > 0) void handleFiles(files);
        };
        window.addEventListener("dragenter", onDragEnter);
        window.addEventListener("dragover", onDragOver);
        window.addEventListener("dragleave", onDragLeave);
        window.addEventListener("drop", onDrop);
        return () => {
            window.removeEventListener("dragenter", onDragEnter);
            window.removeEventListener("dragover", onDragOver);
            window.removeEventListener("dragleave", onDragLeave);
            window.removeEventListener("drop", onDrop);
        };
        // handleFiles 仅依赖 setState,首帧闭包即可
    }, []);

    /**
     * 解析上传的文件(可多选 / 可多次拖入):ZIP 按 HAP 解包,其余按裸 abc。
     * 每次调用把新文件追加到已有列表,互不覆盖;多个拖入操作并发时用计数维护 parsing 状态。
     */
    const handleFiles = async (files: File[]): Promise<void> => {
        if (files.length === 0) return;
        setError(null);
        parsingCount.current++;
        setPhase("parsing");
        try {
            await yieldToUI();
            const loaded: LoadedImage[] = [];
            const failures: string[] = [];
            for (const file of files) {
                try {
                    const data = new Uint8Array(await file.arrayBuffer());
                    const hash = await hashBytes(data);
                    const image = loadImage(data, file.name, hash);
                    // 先恢复上次会话保存在浏览器里的结果:列表出现后点开已反编译的类即命中缓存
                    for (const source of image.sources) {
                        await service.hydrate(source);
                        await yieldToUI();
                    }
                    loaded.push(image);
                } catch (e) {
                    failures.push(file.name + ": " + readError(e));
                }
                // 文件之间让出主线程,多文件/大包时进度提示不会卡住
                await yieldToUI();
            }
            if (loaded.length > 0) setImages((prev) => [...prev, ...loaded]);
            setCacheVersion((v) => v + 1);
            if (failures.length > 0) setError(failures.join("\n"));
        } finally {
            parsingCount.current--;
            if (parsingCount.current === 0) setPhase("idle");
        }
    };

    const onInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (files.length > 0) void handleFiles(files);
    };

    /**
     * 全量反编译:optimize 模式的 simplify 交给 Web Worker 池(默认 4 线程),
     * 主线程只在类间构建 AST 并刷新进度;raw 模式无 simplify 阶段,保持串行。
     */
    const runBulk = async (): Promise<void> => {
        if ((bulk !== null && bulk.running) || refs.length === 0) return;
        bulkCancel.current = false;
        const pendingCount = refs.filter((ref) => service.peek(ref, mode) === undefined).length;
        const runJobs = mode === "simplify" ? Math.min(workerJobs, Math.max(1, pendingCount)) : 1;
        let done = refs.length - pendingCount;
        let failed = 0;
        const publish = (running: boolean, cancelled: boolean): void => {
            setBulk({ running, done, total: refs.length, failed, cancelled, jobs: runJobs });
        };
        publish(true, false);
        await yieldToUI();
        try {
            await service.decompileMany(refs, mode, {
                jobs: runJobs,
                shouldStop: () => bulkCancel.current,
                onClassDone: () => {
                    done++;
                    publish(true, false);
                },
                onClassFailed: (ref, e) => {
                    done++;
                    failed++;
                    console.error("decompile failed: " + ref.displayPath, e);
                    publish(true, false);
                },
                onWarning: (message) => console.warn(message),
            });
        } finally {
            publish(false, bulkCancel.current);
            setCacheVersion((v) => v + 1);
        }
    };

    /** 打包全部已反编译类下载;多来源时按来源目录分段(与 cli 落盘结构一致) */
    const downloadAll = (): void => {
        const multiSource = images.reduce((n, img) => n + img.sources.length, 0) > 1;
        const files: Zippable = {};
        for (const ref of refs) {
            const code = service.peek(ref, mode);
            if (code === undefined || code === "") continue;
            files[zipPathFor(ref, multiSource)] = strToU8(code);
        }
        if (Object.keys(files).length === 0) return;
        const zipped = zipSync(files, { level: 4 });
        const base = images.length === 1 ? sanitizeFileName(stripExt(images[0].fileName)) : "xpanda-output";
        downloadBlob(new Blob([zipped], { type: "application/zip" }), base + "-" + mode + ".zip");
    };

    const redecompileSelected = (): void => {
        if (selected === null) return;
        service.invalidate(selected, mode);
        setCacheVersion((v) => v + 1); // 触发 effect 重新反编译
    };

    /** 关闭一个已加载文件:释放其字节码与内存缓存(浏览器里保存的结果保留),回到可加载状态 */
    const closeImage = (imageId: string): void => {
        const img = images.find((i) => i.id === imageId);
        if (img === undefined) return;
        service.clearSources(img.sources.map((s) => s.cacheKey));
        for (const source of img.sources) {
            referenceWorkers.current.get(source.id)?.dispose();
            referenceWorkers.current.delete(source.id);
        }
        setReferenceIndexes((current) => {
            const next = new Map(current);
            for (const source of img.sources) next.delete(source.id);
            return next;
        });
        setImages((prev) => prev.filter((i) => i.id !== imageId));
        // 选中的类属于被关闭文件时清空选中;窄屏下回到类列表视图
        if (selected !== null && selected.source.image.id === imageId) {
            setSelected(null);
            setMobileView("list");
        }
        setBulk(null);
        setCacheVersion((v) => v + 1);
    };

    /** 关闭全部文件:清空整个内存缓存,回到欢迎页(浏览器里保存的结果保留) */
    const closeAll = (): void => {
        service.clear();
        for (const worker of referenceWorkers.current.values()) worker.dispose();
        referenceWorkers.current.clear();
        setImages([]);
        setSelected(null);
        setReferenceIndexes(new Map());
        setReferenceSourceId(null);
        setReferencesOpen(false);
        setBulk(null);
        setMobileView("list");
        setCacheVersion((v) => v + 1);
    };

    /** 清空浏览器里保存的反编译结果(当前会话已显示的内容保留) */
    const clearSavedCache = (): void => {
        if (!window.confirm(
            "Delete the decompile results stored in this browser? " +
            "They will be decompiled again after the page is reloaded.",
        )) return;
        void service.clearPersistent();
    };

    const toggleReferences = (): void => {
        if (referencesOpen) {
            setReferencesOpen(false);
            return;
        }
        setReferenceSourceId(selected?.source.id ?? sources[0]?.id ?? null);
        setReferencesOpen(true);
        setMobileView("code");
    };

    const getReferenceIndex = useCallback((source: AbcSource, rebuild = false): Promise<XrefWorkerClient> => {
        const task = referenceTask.current;
        if (task) return task.sourceId === source.id ? task.promise : Promise.reject(new Error("Another ABC is being indexed. Try again when it finishes."));
        const existing = referenceWorkers.current.get(source.id);
        if (existing && !rebuild) return Promise.resolve(existing);
        setReferenceError(null);
        setReferenceBuild({ sourceId: source.id, done: 0, total: 0 });
        existing?.dispose();
        referenceWorkers.current.delete(source.id);
        setReferenceIndexes((current) => {
            const next = new Map(current);
            next.delete(source.id);
            return next;
        });
        const promise = buildXrefsInWorker(source.pandaFile.data, (done, total) => {
            setReferenceBuild((current) => current?.sourceId === source.id ? { sourceId: source.id, done, total } : current);
        }).then((index) => {
            referenceWorkers.current.set(source.id, index);
            setReferenceIndexes((current) => new Map(current).set(source.id, index));
            return index;
        }).catch((e: unknown) => {
            setReferenceError({ sourceId: source.id, message: readError(e) });
            throw e;
        }).finally(() => {
            referenceTask.current = null;
            setReferenceBuild((current) => current?.sourceId === source.id ? null : current);
        });
        referenceTask.current = { sourceId: source.id, promise };
        return promise;
    }, []);

    const buildReferences = (source: AbcSource): void => {
        void getReferenceIndex(source, true).catch((e: unknown) => {
            setReferenceError({ sourceId: source.id, message: readError(e) });
        });
    };

    const openReferencedClass: CodeNavigate = (sourceId, classOffset, symbol = "", line, reference): void => {
        const ref = refs.find((candidate) => candidate.source.id === sourceId && candidate.clazz.getOffset() === classOffset);
        if (!ref) { setError("The referenced record has no displayable module in this ABC."); return; }
        setCodeJump((previous) => ({ sourceId, classOffset, symbol, line, reference, sequence: (previous?.sequence ?? 0) + 1 }));
        setSelected(ref);
        setReferencesOpen(false);
        setMobileView("code");
    };

    return (
        <div className="app">
            <Topbar
                onOpen={() => fileInputRef.current?.click()}
                mode={mode}
                onModeChange={setMode}
                disabled={phase === "parsing"}
                referencesActive={referencesOpen}
                referencesDisabled={sources.length === 0}
                onToggleReferences={toggleReferences}
            />
            <NoticeBar />
            {error !== null && (
                <div className="errorbar">
                    <pre className="errorbar-text">{error}</pre>
                    <button className="errorbar-close" onClick={() => setError(null)} title="Dismiss">
                        ×
                    </button>
                </div>
            )}
            {images.length > 0 && (
                <BulkBar
                    bulk={bulk}
                    total={refs.length}
                    cachedCount={cachedCount}
                    jobs={workerJobs}
                    onJobsChange={(jobs) => {
                        setWorkerJobs(jobs);
                        saveWorkerJobs(jobs);
                    }}
                    onRun={() => void runBulk()}
                    onCancel={() => {
                        bulkCancel.current = true;
                    }}
                    onDownloadAll={downloadAll}
                    onClearCache={clearSavedCache}
                />
            )}
            <div className={"main" + (isNarrow ? " mobile-view-" + mobileView : "")}>
                {images.length === 0 ? (
                    <div className="welcome">
                        <div className="welcome-card">
                            <div className="welcome-logo">
                                xpanda <em>web</em>
                            </div>
                            <p className="welcome-text">
                                Decompile HarmonyOS <code>.abc</code> bytecode and <code>.hap</code> app packages
                                entirely in your browser — nothing is uploaded.
                            </p>
                            <button className="btn-accent welcome-btn" onClick={() => fileInputRef.current?.click()}>
                                Choose .abc / .hap file
                            </button>
                            <p className="welcome-drop">…or drag &amp; drop anywhere</p>
                        </div>
                    </div>
                ) : (
                    <>
                        <Sidebar
                            images={images}
                            refs={refs}
                            selectedKey={selected?.key ?? null}
                            cachedKeys={cachedKeys}
                            onSelect={(ref) => {
                                setSelected(ref);
                                setReferencesOpen(false);
                                setMobileView("code");
                            }}
                            onCloseImage={closeImage}
                            onCloseAll={images.length > 1 ? closeAll : undefined}
                            closeDisabled={(bulk !== null && bulk.running) || referenceBuild !== null}
                        />
                        {referencesOpen ? (
                            <ReferencePane
                                sources={sources}
                                sourceId={referenceSource?.id ?? null}
                                onSourceChange={setReferenceSourceId}
                                index={referenceSource ? referenceIndexes.get(referenceSource.id) : undefined}
                                building={referenceBuild?.sourceId === referenceSource?.id}
                                progress={referenceBuild?.sourceId === referenceSource?.id
                                    ? { done: referenceBuild.done, total: referenceBuild.total }
                                    : { done: 0, total: 0 }}
                                error={referenceError?.sourceId === referenceSource?.id ? referenceError.message : null}
                                onBuild={buildReferences}
                                onOpenClass={openReferencedClass}
                                onBack={isNarrow ? () => setMobileView("list") : undefined}
                            />
                        ) : (
                            <CodePane
                                selected={selected}
                                code={currentCode}
                                elapsedMs={currentElapsed}
                                decompiling={phase === "decompiling"}
                                mode={mode}
                                onRedecompile={redecompileSelected}
                                jump={codeJump}
                                onNavigate={openReferencedClass}
                                getReferenceIndex={getReferenceIndex}
                                referenceProgress={referenceBuild?.sourceId === selected?.source.id ? referenceBuild : null}
                                onBack={isNarrow ? () => setMobileView("list") : undefined}
                            />
                        )}
                    </>
                )}
            </div>
            {dragging && (
                <div className="drop-overlay">
                    <div className="drop-overlay-box">Drop .abc / .hap to decompile</div>
                </div>
            )}
            {phase === "parsing" && (
                <div className="busy-overlay">
                    <div className="spinner" />
                    <span>Parsing file…</span>
                </div>
            )}
            <input
                ref={fileInputRef}
                type="file"
                accept=".abc,.hap"
                multiple
                style={{ display: "none" }}
                onChange={onInputChange}
            />
        </div>
    );
}
