export interface VecLike {
	x: number;
	y: number;
	z?: number;
	pressure?: number;
}

export interface StrokeOptions {
	size?: number;
	thinning?: number;
	smoothing?: number;
	streamline?: number;
	easing?: (pressure: number) => number;
	simulatePressure?: boolean;
	start?: {
		cap?: boolean;
		taper?: number | boolean;
		easing?: (distance: number) => number;
	};
	end?: {
		cap?: boolean;
		taper?: number | boolean;
		easing?: (distance: number) => number;
	};
	last?: boolean;
}

export interface StrokePoint {
	point: Vec;
	input: Vec;
	vector: Vec;
	pressure: number;
	distance: number;
	runningLength: number;
	radius: number;
}

const MIN_START_PRESSURE = 0.025;
const MIN_END_PRESSURE = 0.01;
const RATE_OF_PRESSURE_CHANGE = 0.275;
const FIXED_PI = Math.PI + 0.0001;

export const TLDRAW_EASINGS = {
	linear: (t: number) => t,
	easeOutSine: (t: number) => Math.sin((t * Math.PI) / 2),
	easeOutQuad: (t: number) => t * (2 - t),
	easeOutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
	pen: (t: number) => t * 0.65 + Math.sin((t * Math.PI) / 2) * 0.35
};

export class Vec {
	x: number;
	y: number;
	z: number;

	constructor(x = 0, y = 0, z = 0) {
		this.x = x;
		this.y = y;
		this.z = z;
	}

	static From(point: VecLike): Vec {
		return new Vec(point.x, point.y, point.z ?? point.pressure ?? 0.5);
	}

	static Add(a: Vec, b: Vec): Vec {
		return new Vec(a.x + b.x, a.y + b.y, a.z + b.z);
	}

	static AddXY(a: Vec, x: number, y: number): Vec {
		return new Vec(a.x + x, a.y + y, a.z);
	}

	static Sub(a: Vec, b: Vec): Vec {
		return new Vec(a.x - b.x, a.y - b.y, a.z - b.z);
	}

	static Mul(a: Vec, scalar: number): Vec {
		return new Vec(a.x * scalar, a.y * scalar, a.z * scalar);
	}

	static Per(point: Vec): Vec {
		return new Vec(point.y, -point.x, point.z);
	}

	static Dist(a: Vec, b: Vec): number {
		return Math.sqrt(Vec.Dist2(a, b));
	}

	static Dist2(a: Vec, b: Vec): number {
		const dx = a.x - b.x;
		const dy = a.y - b.y;
		return dx * dx + dy * dy;
	}

	static Dpr(a: Vec, b: Vec): number {
		return a.x * b.x + a.y * b.y;
	}

	static Lrp(a: Vec, b: Vec, t: number): Vec {
		return new Vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
	}

	static RotWith(point: Vec, center: Vec, rotation: number): Vec {
		const x = point.x - center.x;
		const y = point.y - center.y;
		const cos = Math.cos(rotation);
		const sin = Math.sin(rotation);
		return new Vec(x * cos - y * sin + center.x, x * sin + y * cos + center.y, point.z);
	}

	clone(): Vec {
		return new Vec(this.x, this.y, this.z);
	}

	lrp(point: Vec, t: number): Vec {
		this.x += (point.x - this.x) * t;
		this.y += (point.y - this.y) * t;
		this.z += (point.z - this.z) * t;
		return this;
	}

	equals(point: Vec): boolean {
		return this.x === point.x && this.y === point.y && this.z === point.z;
	}

	uni(): Vec {
		const length = Math.sqrt(this.x * this.x + this.y * this.y);
		if (length === 0) return new Vec(1, 0, this.z);
		this.x /= length;
		this.y /= length;
		return this;
	}

	mul(scalar: number): Vec {
		this.x *= scalar;
		this.y *= scalar;
		this.z *= scalar;
		return this;
	}

	dpr(point: Vec): number {
		return this.x * point.x + this.y * point.y;
	}

	cpr(point: Vec): number {
		return this.x * point.y - this.y * point.x;
	}

	per(): Vec {
		const x = this.x;
		this.x = this.y;
		this.y = -x;
		return this;
	}

	neg(): Vec {
		this.x = -this.x;
		this.y = -this.y;
		this.z = -this.z;
		return this;
	}
}

export function getStrokePoints(rawInputPoints: VecLike[], options: StrokeOptions = {}): StrokePoint[] {
	const { streamline = 0.5, size = 16, simulatePressure = false } = options;
	if (rawInputPoints.length === 0) return [];

	const t = 0.15 + (1 - streamline) * 0.85;
	let pts = rawInputPoints.map(Vec.From);
	let pointsRemovedFromNearEnd = 0;

	if (!simulatePressure) {
		let pt = pts[0];
		while (pt) {
			if (pt.z >= MIN_START_PRESSURE) break;
			pts.shift();
			pt = pts[0];
		}
	}

	if (!simulatePressure) {
		let pt = pts[pts.length - 1];
		while (pt) {
			if (pt.z >= MIN_END_PRESSURE) break;
			pts.pop();
			pt = pts[pts.length - 1];
		}
	}

	if (pts.length === 0) {
		return [{
			point: Vec.From(rawInputPoints[0]),
			input: Vec.From(rawInputPoints[0]),
			pressure: simulatePressure ? 0.5 : 0.15,
			vector: new Vec(1, 1),
			distance: 0,
			runningLength: 0,
			radius: 1
		}];
	}

	let pt = pts[1];
	while (pt) {
		if (Vec.Dist2(pt, pts[0]) > (size / 3) ** 2) break;
		pts[0].z = Math.max(pts[0].z, pt.z);
		pts.splice(1, 1);
		pt = pts[1];
	}

	const last = pts.pop();
	if (!last) return [];
	pt = pts[pts.length - 1];
	while (pt) {
		if (Vec.Dist2(pt, last) > (size / 3) ** 2) break;
		pts.pop();
		pt = pts[pts.length - 1];
		pointsRemovedFromNearEnd++;
	}
	pts.push(last);

	const isComplete =
		options.last ||
		!options.simulatePressure ||
		(pts.length > 1 && Vec.Dist2(pts[pts.length - 1], pts[pts.length - 2]) < size ** 2) ||
		pointsRemovedFromNearEnd > 0;

	if (pts.length === 2 && options.simulatePressure) {
		const end = pts[1];
		pts = pts.slice(0, -1);
		for (let index = 1; index < 5; index++) {
			const next = Vec.Lrp(pts[0], end, index / 4);
			next.z = ((pts[0].z + (end.z - pts[0].z)) * index) / 4;
			pts.push(next);
		}
	}

	const strokePoints: StrokePoint[] = [{
		point: pts[0],
		input: pts[0],
		pressure: simulatePressure ? 0.5 : pts[0].z,
		vector: new Vec(1, 1),
		distance: 0,
		runningLength: 0,
		radius: 1
	}];

	let totalLength = 0;
	let prev = strokePoints[0];

	if (isComplete && streamline > 0) {
		pts.push(pts[pts.length - 1].clone());
	}

	for (let index = 1, count = pts.length; index < count; index++) {
		const point = !t || (options.last && index === count - 1)
			? pts[index].clone()
			: pts[index].clone().lrp(prev.point, 1 - t);

		if (prev.point.equals(point)) continue;

		const distance = Vec.Dist(point, prev.point);
		totalLength += distance;

		if (index < 4 && totalLength < size) continue;

		prev = {
			input: pts[index],
			point,
			pressure: simulatePressure ? 0.5 : pts[index].z,
			vector: Vec.Sub(prev.point, point).uni(),
			distance,
			runningLength: totalLength,
			radius: 1
		};
		strokePoints.push(prev);
	}

	if (strokePoints[1]?.vector) {
		strokePoints[0].vector = strokePoints[1].vector.clone();
	}

	if (totalLength < 1) {
		const maxPressureAmongPoints = Math.max(0.5, ...strokePoints.map((point) => point.pressure));
		strokePoints.forEach((point) => point.pressure = maxPressureAmongPoints);
	}

	return strokePoints;
}

export function setStrokePointRadii(strokePoints: StrokePoint[], options: StrokeOptions) {
	if (strokePoints.length === 0) return strokePoints;
	const {
		size = 16,
		thinning = 0.5,
		simulatePressure = true,
		easing = TLDRAW_EASINGS.linear,
		start = {},
		end = {}
	} = options;

	const taperStartEase = start.easing ?? TLDRAW_EASINGS.easeOutQuad;
	const taperEndEase = end.easing ?? TLDRAW_EASINGS.easeOutCubic;
	const totalLength = strokePoints[strokePoints.length - 1].runningLength;
	let prevPressure = strokePoints[0].pressure;

	if (!simulatePressure && totalLength < size) {
		const max = strokePoints.reduce((currentMax, point) => Math.max(currentMax, point.pressure), 0.5);
		strokePoints.forEach((point) => {
			point.pressure = max;
			point.radius = size * easing(0.5 - thinning * (0.5 - point.pressure));
		});
		return strokePoints;
	}

	for (const strokePoint of strokePoints) {
		if (strokePoint.runningLength > size * 5) break;
		const sp = Math.min(1, strokePoint.distance / size);
		let pressure: number;
		if (simulatePressure) {
			const rp = Math.min(1, 1 - sp);
			pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
		} else {
			pressure = Math.min(1, prevPressure + (strokePoint.pressure - prevPressure) * 0.5);
		}
		prevPressure = prevPressure + (pressure - prevPressure) * 0.5;
	}

	for (const strokePoint of strokePoints) {
		if (thinning) {
			let { pressure } = strokePoint;
			const sp = Math.min(1, strokePoint.distance / size);
			if (simulatePressure) {
				const rp = Math.min(1, 1 - sp);
				pressure = Math.min(1, prevPressure + (rp - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
			} else {
				pressure = Math.min(1, prevPressure + (pressure - prevPressure) * (sp * RATE_OF_PRESSURE_CHANGE));
			}
			strokePoint.radius = size * easing(0.5 - thinning * (0.5 - pressure));
			prevPressure = pressure;
		} else {
			strokePoint.radius = size / 2;
		}
	}

	const taperStart =
		start.taper === false ? 0 : start.taper === true ? Math.max(size, totalLength) : (start.taper as number);
	const taperEnd =
		end.taper === false ? 0 : end.taper === true ? Math.max(size, totalLength) : (end.taper as number);

	if (taperStart || taperEnd) {
		for (const strokePoint of strokePoints) {
			const { runningLength } = strokePoint;
			const ts = runningLength < taperStart ? taperStartEase(runningLength / taperStart) : 1;
			const te = totalLength - runningLength < taperEnd ? taperEndEase((totalLength - runningLength) / taperEnd) : 1;
			strokePoint.radius = Math.max(0.01, strokePoint.radius * Math.min(ts, te));
		}
	}

	return strokePoints;
}

export function getStrokeOutlineTracks(
	strokePoints: StrokePoint[],
	options: StrokeOptions = {}
): { left: Vec[]; right: Vec[] } {
	const { size = 16, smoothing = 0.5 } = options;
	if (strokePoints.length === 0 || size <= 0) return { left: [], right: [] };

	const firstStrokePoint = strokePoints[0];
	const lastStrokePoint = strokePoints[strokePoints.length - 1];
	const totalLength = lastStrokePoint.runningLength;
	const minDistance = Math.pow(size * smoothing, 2);
	const leftPts: Vec[] = [];
	const rightPts: Vec[] = [];

	let prevVector = strokePoints[0].vector;
	let pl = strokePoints[0].point;
	let pr = pl;
	let tl = pl;
	let tr = pr;
	let isPrevPointSharpCorner = false;

	for (let index = 0; index < strokePoints.length; index++) {
		const strokePoint = strokePoints[index];
		const { point, vector } = strokePoint;
		const prevDpr = strokePoint.vector.dpr(prevVector);
		const nextVector = index < strokePoints.length - 1 ? strokePoints[index + 1].vector : strokePoint.vector;
		const nextDpr = index < strokePoints.length - 1 ? nextVector.dpr(strokePoint.vector) : 1;
		const isPointSharpCorner = prevDpr < 0 && !isPrevPointSharpCorner;
		const isNextPointSharpCorner = nextDpr !== null && nextDpr < 0.2;

		if (isPointSharpCorner || isNextPointSharpCorner) {
			if (nextDpr > -0.62 && totalLength - strokePoint.runningLength > strokePoint.radius) {
				const offset = prevVector.clone().mul(strokePoint.radius);
				const cpr = prevVector.clone().cpr(nextVector);

				if (cpr < 0) {
					tl = Vec.Add(point, offset);
					tr = Vec.Sub(point, offset);
				} else {
					tl = Vec.Sub(point, offset);
					tr = Vec.Add(point, offset);
				}

				leftPts.push(tl);
				rightPts.push(tr);
			} else {
				const offset = prevVector.clone().mul(strokePoint.radius).per();
				const start = Vec.Sub(strokePoint.input, offset);

				for (let step = 1 / 13, t = 0; t < 1; t += step) {
					tl = Vec.RotWith(start, strokePoint.input, FIXED_PI * t);
					leftPts.push(tl);

					tr = Vec.RotWith(start, strokePoint.input, FIXED_PI + FIXED_PI * -t);
					rightPts.push(tr);
				}
			}

			pl = tl;
			pr = tr;

			if (isNextPointSharpCorner) {
				isPrevPointSharpCorner = true;
			}

			continue;
		}

		isPrevPointSharpCorner = false;

		if (strokePoint === firstStrokePoint || strokePoint === lastStrokePoint) {
			const offset = Vec.Per(vector).mul(strokePoint.radius);
			leftPts.push(Vec.Sub(point, offset));
			rightPts.push(Vec.Add(point, offset));
			continue;
		}

		const offset = Vec.Lrp(nextVector, vector, nextDpr).per().mul(strokePoint.radius);
		tl = Vec.Sub(point, offset);

		if (index <= 1 || Vec.Dist2(pl, tl) > minDistance) {
			leftPts.push(tl);
			pl = tl;
		}

		tr = Vec.Add(point, offset);

		if (index <= 1 || Vec.Dist2(pr, tr) > minDistance) {
			rightPts.push(tr);
			pr = tr;
		}

		prevVector = vector;
	}

	return { left: leftPts, right: rightPts };
}

export function getStrokeOutlinePoints(strokePoints: StrokePoint[], options: StrokeOptions = {}): Vec[] {
	const { size = 16, start = {}, end = {}, last: isComplete = false } = options;
	const { cap: capStart = true } = start;
	const { cap: capEnd = true } = end;
	if (strokePoints.length === 0 || size <= 0) return [];

	const firstStrokePoint = strokePoints[0];
	const lastStrokePoint = strokePoints[strokePoints.length - 1];
	const totalLength = lastStrokePoint.runningLength;
	const taperStart =
		start.taper === false ? 0 : start.taper === true ? Math.max(size, totalLength) : (start.taper as number);
	const taperEnd =
		end.taper === false ? 0 : end.taper === true ? Math.max(size, totalLength) : (end.taper as number);
	const { left: leftPts, right: rightPts } = getStrokeOutlineTracks(strokePoints, options);
	const firstPoint = firstStrokePoint.point;
	const lastPoint = strokePoints.length > 1
		? strokePoints[strokePoints.length - 1].point
		: Vec.AddXY(firstStrokePoint.point, 1, 1);

	if (strokePoints.length === 1) {
		if (!(taperStart || taperEnd) || isComplete) {
			const startPoint = Vec.Add(
				firstPoint,
				Vec.Sub(firstPoint, lastPoint).uni().per().mul(-firstStrokePoint.radius)
			);
			const dotPts: Vec[] = [];
			for (let step = 1 / 13, t = step; t <= 1; t += step) {
				dotPts.push(Vec.RotWith(startPoint, firstPoint, FIXED_PI * 2 * t));
			}
			return dotPts;
		}
	}

	const startCap: Vec[] = [];
	if (taperStart || (taperEnd && strokePoints.length === 1)) {
		// Tapered start: no cap.
	} else if (capStart) {
		for (let step = 1 / 8, t = step; t <= 1; t += step) {
			startCap.push(Vec.RotWith(rightPts[0], firstPoint, FIXED_PI * t));
		}
	} else {
		const cornersVector = Vec.Sub(leftPts[0], rightPts[0]);
		const offsetA = Vec.Mul(cornersVector, 0.5);
		const offsetB = Vec.Mul(cornersVector, 0.51);

		startCap.push(
			Vec.Sub(firstPoint, offsetA),
			Vec.Sub(firstPoint, offsetB),
			Vec.Add(firstPoint, offsetB),
			Vec.Add(firstPoint, offsetA)
		);
	}

	const endCap: Vec[] = [];
	const direction = lastStrokePoint.vector.clone().per().neg();

	if (taperEnd || (taperStart && strokePoints.length === 1)) {
		endCap.push(lastPoint);
	} else if (capEnd) {
		const startPoint = Vec.Add(lastPoint, Vec.Mul(direction, lastStrokePoint.radius));
		for (let step = 1 / 29, t = step; t < 1; t += step) {
			endCap.push(Vec.RotWith(startPoint, lastPoint, FIXED_PI * 3 * t));
		}
	} else {
		endCap.push(
			Vec.Add(lastPoint, Vec.Mul(direction, lastStrokePoint.radius)),
			Vec.Add(lastPoint, Vec.Mul(direction, lastStrokePoint.radius * 0.99)),
			Vec.Sub(lastPoint, Vec.Mul(direction, lastStrokePoint.radius * 0.99)),
			Vec.Sub(lastPoint, Vec.Mul(direction, lastStrokePoint.radius))
		);
	}

	return leftPts.concat(endCap, rightPts.reverse(), startCap);
}

export function drawTldrawInkPath(
	context: CanvasRenderingContext2D,
	rawInputPoints: VecLike[],
	options: StrokeOptions = {}
) {
	const strokePoints = getStrokePoints(rawInputPoints, options);
	setStrokePointRadii(strokePoints, options);
	drawTldrawInkStrokePoints(context, strokePoints, options);
}

export function drawTldrawInkStrokePoints(
	context: CanvasRenderingContext2D,
	strokePoints: StrokePoint[],
	options: StrokeOptions = {}
) {
	const partitions = partitionAtElbows(strokePoints);
	for (const partition of partitions) {
		drawTldrawInkPartition(context, partition, options);
	}
}

function partitionAtElbows(points: StrokePoint[]): StrokePoint[][] {
	if (points.length <= 2) return [points];

	const result: StrokePoint[][] = [];
	let currentPartition: StrokePoint[] = [points[0]];
	let prevV = Vec.Sub(points[1].point, points[0].point).uni();

	for (let index = 1, count = points.length; index < count - 1; index++) {
		const prevPoint = points[index - 1];
		const thisPoint = points[index];
		const nextPoint = points[index + 1];
		const nextV = Vec.Sub(nextPoint.point, thisPoint.point).uni();
		const dpr = Vec.Dpr(prevV, nextV);
		prevV = nextV;

		if (dpr < -0.8) {
			const elbowPoint = {
				...thisPoint,
				point: thisPoint.input
			};
			currentPartition.push(elbowPoint);
			result.push(cleanUpPartition(currentPartition));
			currentPartition = [elbowPoint];
			continue;
		}

		currentPartition.push(thisPoint);
		if (dpr > 0.7) continue;

		if (
			(Vec.Dist2(prevPoint.point, thisPoint.point) + Vec.Dist2(thisPoint.point, nextPoint.point)) /
				((prevPoint.radius + thisPoint.radius + nextPoint.radius) / 3) ** 2 <
			1.5
		) {
			currentPartition.push(thisPoint);
			result.push(cleanUpPartition(currentPartition));
			currentPartition = [thisPoint];
			continue;
		}
	}

	currentPartition.push(points[points.length - 1]);
	result.push(cleanUpPartition(currentPartition));
	return result;
}

function cleanUpPartition(partition: StrokePoint[]) {
	const startPoint = partition[0];
	while (partition.length > 2) {
		const nextPoint = partition[1];
		if (
			Vec.Dist2(startPoint.point, nextPoint.point) <
			(((startPoint.radius + nextPoint.radius) / 2) * 0.5) ** 2
		) {
			partition.splice(1, 1);
		} else {
			break;
		}
	}

	const endPoint = partition[partition.length - 1];
	while (partition.length > 2) {
		const prevPoint = partition[partition.length - 2];
		if (
			Vec.Dist2(endPoint.point, prevPoint.point) <
			(((endPoint.radius + prevPoint.radius) / 2) * 0.5) ** 2
		) {
			partition.splice(partition.length - 2, 1);
		} else {
			break;
		}
	}

	if (partition.length > 1) {
		partition[0] = {
			...partition[0],
			vector: Vec.Sub(partition[0].point, partition[1].point).uni()
		};
		partition[partition.length - 1] = {
			...partition[partition.length - 1],
			vector: Vec.Sub(partition[partition.length - 2].point, partition[partition.length - 1].point).uni()
		};
	}

	return partition;
}

function drawTldrawInkPartition(
	context: CanvasRenderingContext2D,
	strokePoints: StrokePoint[],
	options: StrokeOptions = {}
) {
	if (strokePoints.length === 0) return;
	if (strokePoints.length === 1) {
		const point = strokePoints[0].point;
		context.beginPath();
		context.arc(point.x, point.y, strokePoints[0].radius, 0, Math.PI * 2);
		context.fill();
		return;
	}

	const { left, right } = getStrokeOutlineTracks(strokePoints, options);
	if (left.length === 0 || right.length === 0) return;

	right.reverse();
	context.beginPath();
	context.moveTo(left[0].x, left[0].y);

	let current = left[0];
	let previousControl = left[0];
	for (let index = 1; index < left.length; index++) {
		const end = averageVec(left[index - 1], left[index]);
		previousControl = smoothQuadraticTo(context, current, previousControl, end);
		current = end;
	}

	const endPoint = strokePoints[strokePoints.length - 1];
	const endRadius = endPoint.radius;
	const endDirection = endPoint.vector.clone().per().neg();
	const endArcStart = Vec.Add(endPoint.point, Vec.Mul(endDirection, endRadius));
	const endArcEnd = Vec.Add(endPoint.point, Vec.Mul(endDirection, -endRadius));
	context.lineTo(endArcStart.x, endArcStart.y);
	drawArcTo(context, endPoint.point, endRadius, endArcStart, endArcEnd);
	current = endArcEnd;
	previousControl = endArcEnd;

	for (let index = 1; index < right.length; index++) {
		const end = averageVec(right[index - 1], right[index]);
		previousControl = smoothQuadraticTo(context, current, previousControl, end);
		current = end;
	}

	const startPoint = strokePoints[0];
	const startRadius = startPoint.radius;
	const startDirection = startPoint.vector.clone().per();
	const startArcStart = Vec.Add(startPoint.point, Vec.Mul(startDirection, startRadius));
	const startArcEnd = Vec.Add(startPoint.point, Vec.Mul(startDirection, -startRadius));
	context.lineTo(startArcStart.x, startArcStart.y);
	drawArcTo(context, startPoint.point, startRadius, startArcStart, startArcEnd);
	context.closePath();
	context.fill();
}

function smoothQuadraticTo(
	context: CanvasRenderingContext2D,
	current: Vec,
	previousControl: Vec,
	end: Vec
) {
	const control = new Vec(current.x * 2 - previousControl.x, current.y * 2 - previousControl.y);
	context.quadraticCurveTo(control.x, control.y, end.x, end.y);
	return control;
}

function averageVec(a: Vec, b: Vec): Vec {
	return new Vec((a.x + b.x) / 2, (a.y + b.y) / 2);
}

function drawArcTo(context: CanvasRenderingContext2D, center: Vec, radius: number, start: Vec, end: Vec) {
	const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
	const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
	context.arc(center.x, center.y, radius, startAngle, endAngle, false);
}
