# Chart Guide

Every chart is driven by the fields you drop on the shelves. Two rules to remember:

- **Dimensions** (blue pills) group the data — categories, dates, names.
- **Measures** (green pills) are the aggregated numbers — sum(sales), median(profit)…

Fields on **Rows, Columns, Color, Size, Label and Tooltip all count** toward the dimension/measure totals below. The in-app version of this guide (worksheet → Show Me → **? Guide**) also tells you what is missing for the current view.

| Chart | Dims | Measures | How to use |
|---|---|---|---|
| Table | any | any | Always available. Inspect the exact aggregated result any chart will receive. |
| KPI Card | 0 | 1–8 | Big-number cards, one per measure — dashboard headline metrics. |
| Bar | 1–3 | 1–8 | Extra dimensions concatenate on the axis; a dimension on **Color** splits into series. |
| Horizontal Bar | 1–3 | 1–8 | Same as Bar, better for long category labels. |
| Lollipop | 1–2 | 1 | Thin stem + dot — lighter than bars for many categories. |
| Pictorial Bar | 1 | 1 | Bars drawn as stacked segments. |
| Stacked Bar | 1–3 | 1–8 | Stacking dimension on **Color**; several measures form side-by-side stacks. |
| Stacked Bar (H) | 1–3 | 1–8 | Horizontal stacked bar. |
| 100% Stacked Bar | 1–3 | 1–8 | Composition per category, normalized to 100% (per stack). |
| 100% Bar (H) | 1–3 | 1–8 | Horizontal 100% stacked bar. |
| Range Bar | 1–2 | 2 | Floating bar from measure 1 to measure 2 (e.g. MIN→MAX). |
| Bullet | 1 | 2–3 | Value bar vs target tick (+ optional range background). |
| Line | 1–2 | 1–8 | Best with a date dimension — set granularity via pill menu → *Date part*. |
| Smooth Line | 1–2 | 1–8 | Spline-interpolated trend line. |
| Step Line | 1–2 | 1–8 | Values change in steps (prices, stock levels, statuses). |
| Area | 1–2 | 1–8 | Line with fill. |
| Stacked Area | 1–2 | 1–8 | Date on Columns + category on Color (or several measures). |
| Scatter | 0–2 | 2 | X = 1st measure, Y = 2nd. Dimension defines the points, Color splits series. |
| Effect Scatter | 0–2 | 2 | Scatter with animated ripple — presentation highlight. |
| Bubble | 1–2 | 3 | 3rd measure controls bubble size. |
| Pie | 1 | 1 | Keep ~8 slices: pill menu → *Top N* + "Others" on the dimension. |
| Donut | 1 | 1 | Pie with a hole. Same dim/measure requirements. |
| Rose (Nightingale) | 1 | 1 | Slice radius encodes the value — dramatic comparison of magnitudes. |
| Half Donut | 1 | 1 | Semicircle donut — gauge-style composition. |
| Radial Bar | 1 | 1 | Bars sweep circular arcs — striking ranking under ~12 categories. |
| Heatmap | 2 | 1 | Dim1 = X, Dim2 = Y, measure = color. Hour × weekday patterns. |
| Treemap | 1–3 | 1 | Dimensions in hierarchy order; click blocks to drill down. |
| Sunburst | 1–3 | 1 | Radial treemap; inner ring = first dimension. |
| Sankey | 2–4 | 1 | Each dimension is a node column; measure sizes the flows. |
| Funnel | 1 | 1 | Stages auto-sorted by value. |
| Pyramid | 1 | 1 | Ascending funnel — smallest on top. |
| Gauge | 0 | 1–3 | No dimensions; extra measures add pointers to the dial. |
| Radar | 1–2 | 1–8 | Dimension values become axes; each measure is a polygon. |
| Box Plot | 1–2 | 1 | Aggregation is ignored: min/Q1/median/Q3/max computed from the raw column. |
| Calendar Heatmap | 1 | 1 | Date dimension with *Date part = Day*; one calendar per year. |
| Candlestick | 1 | 4 | Measure order: **Open, Close, Low, High**. |
| Waterfall | 1 | 1 | Running total; decreases in red; Total bar appended. |
| Pareto | 1 | 1 | Bars sorted desc + cumulative % line (80/20). |
| Theme River | 2 | 1 | One **date** dimension + one category; measure = stream width. |
| Parallel Coords | 0–1 | 3–12 | Each measure is a vertical axis; rows become lines. |
| Network Graph | 2 | 1 | Dim1 = source node, Dim2 = target node, measure = link strength. |
| Circular Graph | 2 | 1 | Network graph on a ring (chord-style). |
| Tree | 1–3 | 0–1 | Expandable hierarchy from the dimensions, in order. |
| Radial Tree | 1–3 | 0–1 | Tree laid out in a circle — deep hierarchies in less space. |
| Word Cloud | 1 | 1 | Words from the dimension, size from the measure. Use Top N ≈ 100. |
| World Map | 1 | 1 | Dimension values must be **country names in English** ("Brazil", "United States of America"). |
| Symbol Map | 0–2 | 2–3 | Points at coordinates: measures = longitude, latitude, optional size. |
| Flow Map | 0–1 | 4–5 | Animated origin→destination arcs: from-lng, from-lat, to-lng, to-lat, optional width. |
| Bar + Line Combo | 1–2 | 2–8 | Dual axis: each measure's pill menu → *Combo series type* / *Combo axis* picks Bar/Line and Axis 1/2. Unset = 1st measure bars/axis 1, rest lines/axis 2. |

## Table calculations

Any measure pill's menu has a **Table calculation** section: Running Total, Moving Average
(pick a trailing window), Rank (highest-first or lowest-first, ties share a rank), % of Total,
and Difference (delta from the previous category). These are computed client-side over the
already-aggregated result, in the order the categories/marks are drawn — with a **Color**
dimension, each color's line/bar gets its own running total instead of one shared total.

## Reference lines & conditional formatting

- **📏 Reference Lines** (button under the Marks panel): a dashed horizontal line for a
  measure's average, median, min, max, or a constant value, with an optional custom label
  and color. Computed from the chart's own (untransformed) values, so it's independent of
  any table calculation applied to the same measure.
- **🎨 Color Rules** (button under the Marks panel): value-based conditional formatting —
  "color this measure's marks red when > 1000", evaluated top-to-bottom (first match wins).
  Applies to bar/pie-family marks and per-point line/scatter markers.

## Multiple measures

Most cartesian charts accept up to **8 measures** — each becomes its own series with the
measure name in the legend (Tableau's "Measure Names/Values"). Combined with a **Color**
dimension, every color value × measure pair becomes a series named `Color · Measure`;
on stacked charts each measure forms its own stack so stacks sit side by side.

## Recipes

- **Histogram**: drag a numeric field to Columns as a *dimension*, open its pill menu → *Create bins…*, then drop *Number of Records* on Rows and pick Bar.
- **Top 10 products + rest**: pill menu on the product dimension → *Top N* → 10 → group remainder as "Others".
- **Hour × weekday heatmap**: date field twice — once with *Date part = Hour*, once with a calculated field `dayname("order_date")` — plus one measure, chart = Heatmap.
- **80/20 revenue analysis**: customer dimension + sum(sales), chart = Pareto.
- **Log flow**: import a log via the Text Import Wizard, then service → status dimensions + Count of Records, chart = Sankey or Network Graph.
