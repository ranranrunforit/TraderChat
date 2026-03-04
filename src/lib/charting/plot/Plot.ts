import type { PineData } from "../../domain/PineData";

export type Plot = {
    data: PineData[],
    options: PlotOptions,
    title: string,
    _plotKey: string,
}

// export type PlotCharOptions = {
//     title?: string;
//     char?: string;
//     location?: Location;
//     color?: string;
//     offset?: number;
//     text?: string;
//     textcolor?: string;
//     editable?: boolean;
//     size?: number;
//     show_last?: boolean;
//     display?: boolean;
//     format?: string;
//     precision?: number;
//     force_overlay?: boolean;
//     style?: string // added by me, may need to remove
// };

export type PlotOptions = {
    _plotKey?: string;
    series?: number;
    title?: string;
    plot1?: string | number; // will be converted number atIndex 
    plot2?: string | number; // will be converted number atIndex 
    color?: string;
    linewidth?: number;
    linestyle?: string;
    style?: string;
    trackprice?: boolean;
    histbase?: boolean;
    offset?: number;
    join?: boolean;
    editable?: boolean;
    show_last?: boolean;
    display?: boolean;
    format?: string;
    precision?: number;
    force_overlay?: boolean;
    fillgaps?: boolean;
    text?: string;
    textcolor?: string;
    char?: string;
    shape?: string;
    size?: string;
    location?: Location; // added by me, may need to remove
};

// export type PlotShapeOptions = {
//     series?: number;
//     title?: string;
//     _plotKey?: string;
//     style?: string;
//     shape?: string;
//     location?: Location;
//     color?: string;
//     offset?: number;
//     text?: string;
//     textcolor?: string;
//     editable?: boolean;
//     size?: string;
//     show_last?: number;
//     display?: string;
//     format?: string;
//     precision?: number;
//     force_overlay?: boolean;
// }

export type Location = 'AboveBar' | 'BelowBar' | 'Top' | 'Bottom' | 'Absolute'

export type Shape =
    'shape_xcross' |
    'shape_cross' |
    'shape_circle' |
    'shape_triangleup' |
    'shape_triangledown' |
    'shape_flag' |
    'shape_arrowup' |
    'shape_arrowdown' |
    'shape_square' |
    'shape_diamond' |
    'shape_labelup' |
    'shape_labeldown'
