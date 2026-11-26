#!/usr/bin/env python3
"""Train the winter Pocket Assistant classifier and rebuild index.html + model.json.

Does not splice JS through re.sub. The page is concatenated from prefix, topic
details, a form suffix, and a runtime script that fetches a versioned model.json.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import math
import re
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
WINTER = ROOT.parent / "winter"
TOKEN = re.compile(r"[a-z0-9_]+|==|=")
STOP = {
    "a", "about", "an", "are", "can", "could", "do", "does", "example", "explain",
    "for", "help", "how", "i", "in", "is", "it", "me", "mean", "means", "my", "of",
    "please", "python", "show", "teach", "tell", "the", "to", "use", "using", "what",
    "why", "with", "would", "you",
}
TEMPLATES = [
    "{title}",
    "what is {title}",
    "what's {title}",
    "whats {title}",
    "explain {title}",
    "how does {title} work",
    "tell me about {title}",
    "help with {title}",
    "i need help with {title}",
    "can you explain {title}",
    "what does {title} mean",
    "{title} explained",
    "teach me about {title}",
    "i don't understand {title}",
    "simple explanation of {title}",
    "quick question about {title}",
    "what are {title}",
    "how do {title} work",
    "why does {title} matter",
    "define {title}",
    "how can i {title}",
    "how do i {title}",
    "{title} meaning",
    "what is a {title}",
    "what is the {title}",
    "can you help me with {title}",
    "i have a question about {title}",
    "please explain {title}",
    "i'm confused about {title}",
    "help me understand {title}",
    "give me a quick answer about {title}",
    "basic {title}",
    "{title} basics",
    "how does {title} work exactly",
]


def tokenize(s: str) -> list[str]:
    return TOKEN.findall(s.lower())


def phrase(s: str) -> str:
    return " ".join(tokenize(s))


def content_words(s: str) -> list[str]:
    return [w for w in tokenize(s) if w not in STOP]


def feature_set(words: list[str]) -> set[str]:
    feats = set(words)
    for w in words:
        p = "^" + w + "$"
        for i in range(0, len(p) - 2):
            feats.add("~" + p[i : i + 3])
    return feats


def fill_prompts(title: str, seeds: list[str], n: int = 20) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def add(s: str) -> None:
        p = phrase(s)
        if p and p not in seen:
            seen.add(p)
            out.append(s)

    for s in seeds:
        add(s)
    t = title.lower()
    for tmpl in TEMPLATES:
        add(tmpl.format(title=t))
        if len(out) >= n:
            return out[:n]
    raise SystemExit(f"Could not fill 20 prompts for {title!r} (got {len(out)})")


def load_topics() -> list[dict]:
    files = sorted(DATA.glob("topics-*.json"))
    if not files:
        raise SystemExit(f"No topics-*.json files in {DATA}")
    topics: list[dict] = []
    seen_titles: set[str] = set()
    for path in files:
        batch = json.loads(path.read_text())
        for t in batch:
            key = phrase(t["title"])
            if not key:
                raise SystemExit(f"Empty title in {path}")
            if key in seen_titles:
                raise SystemExit(f"Duplicate title {t['title']!r} in {path}")
            seen_titles.add(key)
            prompts = fill_prompts(t["title"], t.get("prompts") or [], 20)
            topics.append({
                "title": t["title"],
                "desc": t["desc"],
                "code": t.get("code") or "",
                "answer": t.get("answer") or "",
                "prompts": prompts,
            })
    return topics


def compute_idf(docs: list[set[str]]) -> dict[str, float]:
    df: dict[str, int] = {}
    for feats in docs:
        for tok in feats:
            df[tok] = df.get(tok, 0) + 1
    n = len(docs)
    return {tok: math.log((n + 1) / (c + 1)) + 1.0 for tok, c in df.items()}


def vector_parts(feats: set[str], vocab: dict[str, int], idf: list[float]):
    ids = [vocab[t] for t in feats if t in vocab]
    if not ids:
        return None
    if len(ids) / len(feats) < 0.43:
        return None
    weights = np.array([idf[i] for i in ids], dtype=np.float64)
    norm = math.sqrt(float(np.square(weights).sum()))
    if norm == 0:
        return None
    return np.array(ids, dtype=np.int32), weights / norm


def train_net(xs, ys, n_features: int, n_classes: int, hidden: int, epochs: int, seed: int = 0):
    rng = np.random.default_rng(seed)
    W = rng.normal(0, 0.08, size=(n_features, hidden)).astype(np.float64)
    V = rng.normal(0, 0.08, size=(hidden, n_classes)).astype(np.float64)
    mW = np.zeros_like(W); vW = np.zeros_like(W)
    mV = np.zeros_like(V); vV = np.zeros_like(V)
    lr, b1, b2, eps, l2 = 0.02, 0.9, 0.999, 1e-8, 1e-5
    n = len(xs)
    batch = 64
    for epoch in range(1, epochs + 1):
        order = rng.permutation(n)
        total = 0.0
        correct = 0
        t = 0
        for start in range(0, n, batch):
            idx = order[start : start + batch]
            bsz = len(idx)
            X = np.zeros((bsz, n_features), dtype=np.float64)
            Y = np.zeros(bsz, dtype=np.int32)
            for r, j in enumerate(idx):
                ids, wts = xs[j]
                X[r, ids] = wts
                Y[r] = ys[j]
            h_lin = X @ W
            h = np.tanh(h_lin)
            scores = h @ V
            scores -= scores.max(axis=1, keepdims=True)
            exp = np.exp(scores)
            prob = exp / exp.sum(axis=1, keepdims=True)
            total += float(-np.log(np.clip(prob[np.arange(bsz), Y], 1e-12, 1)).sum())
            pred = prob.argmax(axis=1)
            correct += int((pred == Y).sum())
            dS = prob
            dS[np.arange(bsz), Y] -= 1
            dS /= bsz
            dV = h.T @ dS + l2 * V
            dH = (dS @ V.T) * (1 - h ** 2)
            dW = X.T @ dH + l2 * W
            t += 1
            for param, grad, m, v in (
                (W, dW, mW, vW),
                (V, dV, mV, vV),
            ):
                m *= b1
                m += (1 - b1) * grad
                v *= b2
                v += (1 - b2) * (grad * grad)
                mhat = m / (1 - b1 ** t)
                vhat = v / (1 - b2 ** t)
                param -= lr * mhat / (np.sqrt(vhat) + eps)
        if epoch == 1 or epoch % 5 == 0 or epoch == epochs:
            print(f"  epoch {epoch:02d}  loss={total/n:.4f}  acc={correct/n:.4f}")
    return W, V


def quantize(mat: np.ndarray, cols: int) -> dict:
    flat = mat.astype(np.float64)
    scale = float(np.max(np.abs(flat)) / 127.0) or 1.0
    q = np.clip(np.round(flat / scale), -127, 127).astype(np.int8)
    return {
        "bytes": base64.b64encode(q.tobytes()).decode("ascii"),
        "scale": scale,
        "cols": cols,
    }


def classify_py(s: str, model, W, V, stop, exact, vocab, idf_arr, topics) -> int:
    ph = phrase(s)
    if ph in exact:
        return exact[ph]
    words = content_words(s)
    definition = re.match(r"^what(?: is|'s|s| are) (?:an? |the )?([a-z0-9-]+)[?!.]*$", s.lower().strip())
    if definition and definition.group(1) not in vocab:
        return -1
    feats = feature_set(words)
    parts = vector_parts(feats, vocab, idf_arr)
    if parts is None:
        return -1
    ids, wts = parts
    x = np.zeros(W.shape[0])
    x[ids] = wts
    hidden = np.tanh(x @ W)
    scores = hidden @ V
    mx = scores.max()
    prob = np.exp(scores - mx)
    conf = 1 / prob.sum()  # since exp(max-max)=1, softmax(max)=1/sum
    return int(scores.argmax()) if conf >= 0.74 else -1


def render_details(topics: list[dict]) -> str:
    parts = []
    for t in topics:
        title = html.escape(t["title"], quote=True)
        desc = html.escape(t["desc"], quote=True)
        parts.append(f"<details><summary>{title}</summary><p>{desc}</p></details>")
        if t["code"]:
            # Fallback stays text-only like the existing page (code is revealed in JS).
            pass
    return "".join(parts)


def write_page(topics: list[dict], version: str) -> None:
    prefix = (ROOT / "prefix.html").read_text()
    if not re.fullmatch(r"[0-9.]+", version):
        raise SystemExit(f"Bad version {version!r}")
    # Do not splice JS through re.sub or string-escape replacement.
    page = (
        prefix
        + render_details(topics)
        + "</section><form id=\"chat\" hidden><input id=\"q\" maxlength=\"600\" enterkeyhint=\"send\" "
        "aria-label=\"Your question\" placeholder=\"Message Pocket Assistant…\">"
        "<button type=\"submit\">Send</button></form></main>\n"
        f'<script type="module" src="app.js?v={version}"></script></html>\n'
    )
    dest = WINTER / "index.html"
    dest.write_text(page)
    print("wrote", dest, "bytes", dest.stat().st_size)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hidden", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=35)
    parser.add_argument("--version", default="")
    args = parser.parse_args()

    topics = load_topics()
    print(f"Loaded {len(topics)} topics")
    version = args.version or str(len(topics))

    docs = []
    labels = []
    prompt_texts = []
    for i, t in enumerate(topics):
        for p in t["prompts"]:
            feats = feature_set(content_words(p))
            if not feats:
                raise SystemExit(f"No features for prompt {p!r} ({t['title']})")
            docs.append(feats)
            labels.append(i)
            prompt_texts.append(p)

    idf_map = compute_idf(docs)
    vocab_terms = sorted(idf_map)
    vocab = {tok: i for i, tok in enumerate(vocab_terms)}
    idf_arr = [idf_map[tok] for tok in vocab_terms]

    xs = []
    ys = []
    for feats, y in zip(docs, labels):
        parts = vector_parts(feats, vocab, idf_arr)
        if parts is None:
            # Training docs should always clear the coverage threshold.
            ids = [vocab[t] for t in feats]
            wts = np.array([idf_arr[i] for i in ids], dtype=np.float64)
            norm = math.sqrt(float(np.square(wts).sum())) or 1.0
            parts = (np.array(ids, dtype=np.int32), wts / norm)
        xs.append(parts)
        ys.append(y)

    print(f"Training on {len(xs)} prompts, vocab={len(vocab)}, hidden={args.hidden}")
    W, V = train_net(xs, ys, len(vocab), len(topics), args.hidden, args.epochs)

    exact = {}
    for i, t in enumerate(topics):
        for p in t["prompts"]:
            ph = phrase(p)
            if ph in exact and exact[ph] != i:
                raise SystemExit(f"Exact-phrase collision {ph!r}: {topics[exact[ph]]['title']} vs {t['title']}")
            exact.setdefault(ph, i)

    # Evaluate without using exact matches
    exact_empty = {}
    hits = 0
    confident = 0
    wrong = 0
    abstain = 0
    for p, y in zip(prompt_texts, ys):
        pred = classify_py(p, None, W, V, STOP, exact_empty, vocab, idf_arr, topics)
        if pred == y:
            hits += 1
            confident += 1
        elif pred == -1:
            abstain += 1
        else:
            wrong += 1
    n = len(prompt_texts)
    print(
        f"Classifier only (no exact): acc={hits/n:.4f} abstain={abstain/n:.4f} wrong={wrong/n:.4f}"
    )

    with_exact_wrong = 0
    with_exact_miss = 0
    for p, y in zip(prompt_texts, ys):
        pred = classify_py(p, None, W, V, STOP, exact, vocab, idf_arr, topics)
        if pred != y:
            if pred == -1:
                with_exact_miss += 1
            else:
                with_exact_wrong += 1
    print(f"With exact: misses={with_exact_miss} wrong={with_exact_wrong} / {n}")

    model = {
        "topics": [{"title": t["title"], "desc": t["desc"], "code": t["code"], "answer": t["answer"]} for t in topics],
        "stop": sorted(STOP),
        "vocab": vocab,
        "idf": idf_arr,
        "W": quantize(W, W.shape[1]),
        "V": quantize(V, V.shape[1]),
        "exact": exact,
    }
    dest = WINTER / "model.json"
    dest.write_text(json.dumps(model, ensure_ascii=False, separators=(",", ":")))
    print("wrote", dest, "bytes", dest.stat().st_size)
    write_page(topics, version)
    print(f"Done. {len(topics)} topics, model version {version}")


if __name__ == "__main__":
    main()
