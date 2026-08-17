// dsh-wsl — Client half (hand-written web plugin bundle).
//
// The module table format mirrors a tsdown client bundle: a factory registered
// via window.__ModuleLoader__.load; the factory returns the plugin exports
// surface (apply). The only module dependency is react, a platform seed word.
// It registers one plugin-configuration card in the Web Plugins settings
// (`settings.plugin.item`): a compact horizontal row with the distro picker,
// live distro list, preset status, and warm-up, backed by the host half's
// same-origin JSON API under /wsl-manager/*.
window.__ModuleLoader__.load({
	id: "dsh-wsl",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		function el(type, props, ...children) {
			return React.createElement(type, props, ...children);
		}

		function errText(e) {
			if (e == null) return "unknown error";
			if (typeof e === "object" && e.message != null) return String(e.message);
			return String(e);
		}

		async function api(path, body) {
			const res = await fetch("/wsl-manager" + path, body === undefined
				? { method: "GET" }
				: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const text = await res.text();
			let data = null;
			try { data = text ? JSON.parse(text) : null; } catch { data = null; }
			if (!res.ok) {
				throw new Error((data && data.error) || "HTTP " + res.status);
			}
			if (data === null) {
				// The SPA fallback answered instead of the host API: the host
				// half is not mounted (or failed). Fail loud instead of
				// showing a perpetual loading state.
				throw new Error("wsl-manager API returned a non-JSON response — the dsh-wsl host half is not mounted");
			}
			return data;
		}

		const S = {
			card: { border: "1px solid var(--color-border, #e5e5e5)", borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 },
			head: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
			title: { fontSize: 13, fontWeight: 600 },
			row: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			select: { padding: "4px 8px", border: "1px solid var(--color-border, #ccc)", borderRadius: 6, fontSize: 12, background: "var(--color-bg, transparent)", color: "var(--color-text, inherit)", maxWidth: 220 },
			btn: { padding: "4px 10px", border: "1px solid var(--color-border, #ccc)", borderRadius: 6, background: "transparent", fontSize: 12, cursor: "pointer", color: "var(--color-text, inherit)" },
			note: { fontSize: 12, color: "var(--color-text-secondary, #888)", lineHeight: 1.6 },
			error: { color: "#dc2626", fontSize: 12 },
			ok: { color: "#15803d", fontSize: 12 },
			badgeOn: { fontSize: 11, padding: "1px 7px", borderRadius: 10, border: "1px solid #16a34a", color: "#15803d" },
			badgeOff: { fontSize: 11, padding: "1px 7px", borderRadius: 10, border: "1px solid #9ca3af", color: "#9ca3af" },
			details: { display: "flex", flexDirection: "column", gap: 4 },
		};

		function WslCard() {
			const [status, setStatus] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [saving, setSaving] = React.useState(false);
			const [saveMsg, setSaveMsg] = React.useState(null);
			const [expanded, setExpanded] = React.useState(false);

			async function refresh() {
				setBusy(true);
				setError(null);
				try {
					setStatus(await api("/status"));
				} catch (e) {
					setError(errText(e));
					setStatus(null);
				} finally {
					setBusy(false);
				}
			}

			async function chooseDistro(value) {
				setSaving(true);
				setSaveMsg(null);
				try {
					const r = await api("/distro", { distro: value });
					setSaveMsg(r.ok ? "已保存（立即生效）" : "保存失败");
					await refresh();
				} catch (e) {
					setSaveMsg(errText(e));
				} finally {
					setSaving(false);
				}
			}

			async function warmup() {
				setSaveMsg(null);
				try {
					const r = await api("/warmup", {});
					setSaveMsg(r.ok ? "预热已启动" : "预热启动失败");
				} catch (e) {
					setSaveMsg(errText(e));
				}
			}

			React.useEffect(() => { refresh(); }, []);

			const distros = (status && status.distros) || [];
			const saved = status ? status.savedDistro : null;
			const fallback = status ? status.defaultDistro : null;
			const current = saved !== null && saved !== "" ? saved : (fallback ?? "");
			const anyRunning = distros.some((d) => d.state === "Running");
			const saveIsError = saveMsg !== null && (saveMsg.includes("失败") || (!saveMsg.startsWith("已保存") && !saveMsg.startsWith("预热已")));

			return el("div", { style: S.card },
				el("div", { style: S.head },
					el("span", { style: S.title }, "WSL"),
					el("span", { style: S.note }, "命令在 Windows Subsystem for Linux 中执行"),
					el("span", { style: { marginLeft: "auto" } },
						status === null
							? null
							: status.available
								? el("span", { style: S.badgeOn }, "可用")
								: el("span", { style: S.badgeOff }, "不可用"),
					),
				),
				error ? el("div", { style: S.error }, error) : null,
				status === null ? el("div", { style: S.row },
					el("span", { style: S.note }, busy ? "正在加载…" : "正在加载…"),
				) : el("div", { style: S.row },
					el("label", { style: S.row },
						el("span", { style: S.note }, "发行版"),
						el("select", {
							style: S.select,
							value: current,
							disabled: saving || !status.available || distros.length === 0,
							onChange: (e) => chooseDistro(e.target.value),
						},
							el("option", { key: "", value: "" }, "默认（" + (fallback ?? "未设置") + "）"),
							distros.map((d) => el("option", { key: d.name, value: d.name },
								d.name + (d.isDefault ? "（默认）" : "") + " · " + d.state,
							)),
						),
					),
					saving ? el("span", { style: S.note }, "保存中…") : null,
					saveMsg !== null ? el("span", { style: saveIsError ? S.error : S.ok }, saveMsg) : null,
					el("span", { style: S.note }, anyRunning ? "有发行版运行中" : "全部已停止（首次调用会冷启动）"),
					el("button", { style: S.btn, onClick: warmup, disabled: !status.available }, "预热"),
					el("span", { style: S.note },
						status.preset && status.preset.installed
							? "minimal-wsl 预设已安装 ✓"
							: "minimal-wsl 预设未安装（宿主半边加载时自动安装）",
					),
				),
				status === null ? null : el("div", { style: S.row },
					el("button", { style: S.btn, onClick: () => setExpanded(!expanded) }, expanded ? "收起说明 ▴" : "使用说明 ▾"),
					el("button", { style: S.btn, onClick: refresh, disabled: busy }, busy ? "刷新中…" : "刷新"),
				),
				expanded ? el("div", { style: S.details },
					el("div", { style: S.note }, "• 路径规则：文件工具用 Windows 路径（D:\\dir\\file），bash 命令用 WSL 路径（/mnt/d/dir/file），同一份文件。"),
					el("div", { style: S.note }, "• 沙箱：WSL VM 内的进程不受 Windows 沙箱约束，bash/wsl 工具仅在会话切到「完全访问」后放行；受限模式会返回明确指引。"),
					el("div", { style: S.note }, "• 预设：新建会话选择「极简模式 (WSL)」，bash 即走 WSL（非持久 + 持久 PTY 双通道）。"),
					el("div", { style: S.note }, "• 已知限制：不支持 stdin 转发（用 heredoc）；/mnt/* 走 9P，重依赖构建建议放 WSL 家目录。"),
				) : null,
			);
		}

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			slots.inject("settings.plugin.item", () => slots.register(
				{ name: "settings.plugin.item", id: "wsl", order: 40, label: "WSL" },
				() => el(WslCard),
			));
		}

		exports.apply = apply;
		return module.exports;
	}
});
