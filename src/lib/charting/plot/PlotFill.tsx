import { TVar } from "../../timeseris/TVar";
import { Path } from "../../svg/Path";
import type { ChartYControl } from "../view/ChartYControl";
import type { ChartXControl } from "../view/ChartXControl";
import type { PlotOptions } from "./Plot";
import type { PineData } from "../../domain/PineData";
import type { Seg } from "../../svg/Seg";

type Props = {
    xc: ChartXControl;
    yc: ChartYControl;
    tvar: TVar<PineData[]>;
    name: string;
    options: PlotOptions;
    depth?: number;
};

const PlotFill = ({ xc, yc, tvar, options }: Props) => {
    const fillgaps = options.fillgaps;

    function plot() {
        const plot1Index = options.plot1 as number;
        const plot2Index = options.plot2 as number;

        const segs: Seg[] = [];
        const synchronizedPoints: { xa?: number, ya?: number, xb?: number, yb?: number }[] = [];

        // Collect points synchronously to prevent X-axis desynchronization 
        for (let bar = 1; bar <= xc.nBars; bar++) {
            const time = xc.tb(bar);
            let ya: number | undefined;
            let yb: number | undefined;

            if (tvar.occurred(time)) {
                const datas = tvar.getByTime(time);
                if (datas) {
                    const v1 = datas[plot1Index]?.value;
                    const v2 = datas[plot2Index]?.value;

                    if (typeof v1 === "number" && !isNaN(v1)) ya = yc.yv(v1);
                    if (typeof v2 === "number" && !isNaN(v2)) yb = yc.yv(v2);
                }
            }

            const x = xc.xb(bar);
            const isValidPoint = ya !== undefined && !isNaN(ya) && yb !== undefined && !isNaN(yb);

            if (isValidPoint) {
                synchronizedPoints.push({ xa: x, ya, xb: x, yb });
            } else if (!fillgaps) {
                synchronizedPoints.push({}); // Represents a gap
            }
        }

        let shallStartNewFill = true;
        let unClosedPath: Path | undefined;
        let lastCloseIndex = 0;

        for (let m = 0; m < synchronizedPoints.length; m++) {
            const { xa, ya } = synchronizedPoints[m];

            if (xa === undefined) {
                // We hit a gap
                if (unClosedPath) {
                    // Trace backward to draw the bottom edge
                    for (let n = m - 1; n >= lastCloseIndex; n--) {
                        const { xb, yb } = synchronizedPoints[n];
                        if (xb !== undefined && yb !== undefined) {
                            unClosedPath.lineto(xb, yb);
                        }
                    }
                    unClosedPath.closepath();
                    unClosedPath = undefined;
                }
                shallStartNewFill = true;

            } else {
                if (shallStartNewFill) {
                    unClosedPath = new Path();
                    segs.push(unClosedPath);

                    unClosedPath.moveto(xa, ya);

                    lastCloseIndex = m;
                    shallStartNewFill = false;
                } else {
                    unClosedPath.lineto(xa, ya);
                }
            }
        }

        // Clean up remaining unclosed paths
        if (unClosedPath) {
            for (let n = synchronizedPoints.length - 1; n >= lastCloseIndex; n--) {
                const { xb, yb } = synchronizedPoints[n];
                if (xb !== undefined && yb !== undefined) {
                    unClosedPath.lineto(xb, yb);
                }
            }
            unClosedPath.closepath();
        }

        return { segs };
    }

    const { segs } = plot();

    return (
        <>
            {segs.map((seg, n) =>
                seg.render({ key: `seg-${n}`, style: { stroke: undefined, fill: options.color } })
            )}
        </>
    );
};

export default PlotFill;