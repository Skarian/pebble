// Sampled from the 8×8 palette reference images in czmanix/pebble-color-optimizer.
// Palette ordering is significant: one index represents the same Pebble color
// across the standard, sun, room, and backlight arrays.

export const PALETTES = Object.freeze({
  corrected: Object.freeze([
    "#000000", "#001E41", "#004387", "#4A161B", "#0068CA", "#482748", "#40488A", "#2B4A2C",
    "#983E5A", "#16638D", "#955694", "#564E36", "#E35462", "#007DCE", "#8F74D2", "#545454",
    "#5E9860", "#9D5B4D", "#4180D0", "#DE83DC", "#5C9B72", "#9D6064", "#57A5A2", "#9A7099",
    "#9587D5", "#759D76", "#E6727C", "#71A6A4", "#E37FA7", "#8EE391", "#AFA072", "#69B5DD",
    "#8AEBC0", "#ABABAB", "#9EE594", "#F1AA86", "#84F5F1", "#A7BAE2", "#9DE7A0", "#F1AD93",
    "#95F6F2", "#ECC3EB", "#C9EAA7", "#C7F0C8", "#FFEEAB", "#C3F9F7", "#FFF1B5", "#FFF6D3",
    "#C9E89D", "#AEA382", "#FFFFFF", "#9BECC2", "#E194DF", "#759A64", "#E25874", "#99353F",
    "#4CB4DB", "#E16AA3", "#27514F", "#EFB5B8", "#8EE69E", "#E66E6B", "#4F6790", "#2F6BCC"
  ]),
  standard: Object.freeze([
    "#000000", "#000055", "#0000AA", "#550000", "#0000FF", "#550055", "#5500AA", "#005500",
    "#AA0055", "#0055AA", "#AA00AA", "#555500", "#FF0000", "#0055FF", "#AA00FF", "#555555",
    "#00AA00", "#AA5500", "#5555FF", "#FF00FF", "#00AA55", "#AA5555", "#00AAAA", "#AA55AA",
    "#AA55FF", "#55AA55", "#FF5555", "#55AAAA", "#FF55AA", "#00FF00", "#AAAA00", "#55AAFF",
    "#00FFAA", "#AAAAAA", "#55FF00", "#FFAA00", "#00FFFF", "#AAAAFF", "#55FF55", "#FFAA55",
    "#55FFFF", "#FFAAFF", "#AAFF55", "#AAFFAA", "#FFFF00", "#AAFFFF", "#FFFF55", "#FFFFAA",
    "#AAFF00", "#AAAA55", "#FFFFFF", "#55FFAA", "#FF55FF", "#55AA00", "#FF0055", "#AA0000",
    "#00AAFF", "#FF00AA", "#005555", "#FFAAAA", "#00FF55", "#FF5500", "#5555AA", "#5500FF"
  ]),
  sun: Object.freeze([
    "#272020", "#26344A", "#1B4168", "#5B2423", "#03487A", "#583447", "#564563", "#3F4932",
    "#883F51", "#3E6C80", "#885070", "#6C523E", "#9E2D32", "#2D708D", "#835980", "#675B5A",
    "#576D45", "#9B5F4F", "#6C758C", "#A35F84", "#527B69", "#926361", "#538486", "#8D6B76",
    "#957B8E", "#808271", "#A96867", "#7A8A8A", "#AE6F7C", "#61865B", "#9D795C", "#728894",
    "#5F9A8F", "#978D88", "#8B906B", "#BA8264", "#65A3A2", "#978D88", "#838D7A", "#B58775",
    "#89A39E", "#B89D94", "#A28B77", "#A7A49B", "#C29774", "#A7A49B", "#B99A83", "#B89D94",
    "#AF916B", "#A28B77", "#BCA9A6", "#859B8D", "#AA7C91", "#7E7554", "#9E4253", "#80282C",
    "#4F8E9B", "#A45675", "#415D60", "#B6918D", "#629178", "#AE5B4B", "#6B6B78", "#55537D"
  ]),
  room: Object.freeze([
    "#141318", "#171C28", "#172136", "#27191E", "#132840", "#2F1E27", "#282639", "#1E2528",
    "#3C2A38", "#233440", "#3C2A38", "#332D28", "#4A2528", "#213849", "#3B3044", "#303030",
    "#2B382E", "#45322F", "#373E4D", "#4A354A", "#2B3A38", "#423439", "#2C4043", "#413840",
    "#443F4E", "#3E403D", "#523A3D", "#3E4347", "#4F3C47", "#344334", "#493E36", "#3A454E",
    "#364F4D", "#4A484B", "#444838", "#58403A", "#305054", "#4A484E", "#424840", "#544240",
    "#445257", "#564D55", "#514D46", "#504F4D", "#5B4C44", "#4F5458", "#5B4C44", "#5A504E",
    "#4F4A3D", "#48423F", "#5B5657", "#434E49", "#4B3F4B", "#39362F", "#442939", "#2F1E27",
    "#2A424C", "#442939", "#1E2528", "#524549", "#31453D", "#4A312E", "#32323B", "#282639"
  ]),
  backlight: Object.freeze([
    "#344474", "#2E67A3", "#2B7DBD", "#73588B", "#2589C8", "#707BB6", "#6888C4", "#507598",
    "#8C81BC", "#4B9CD1", "#8A96D8", "#8C87AF", "#A46F9F", "#4BA8DD", "#8A9FDE", "#859DD0",
    "#648FB1", "#9686B5", "#82B0EA", "#A0A5E7", "#69A4CA", "#97A0D2", "#5EB3DE", "#90AAE0",
    "#8FB4EE", "#85ABDA", "#ADA8DE", "#8CB8E8", "#AFB0E5", "#6E9CB5", "#AEA3C5", "#85BEEA",
    "#65BAE3", "#A0C3F3", "#98AAC9", "#C3A5CD", "#74C4EE", "#A8C6F3", "#93B7DA", "#B3B3DB",
    "#8AC9F5", "#A8CAF8", "#AABAE3", "#B3C8F7", "#CEB1D1", "#ACCEF6", "#B6BDE8", "#B9CAEF",
    "#A8ABCD", "#9BACDB", "#B3D2FA", "#98BDE8", "#ADB4EA", "#8891B1", "#9686B5", "#805F8B",
    "#53AFE4", "#8C92D1", "#4285B5", "#B6BDE8", "#69A4CA", "#AB8CAE", "#7699C8", "#6888C4"
  ])
});

export const PALETTE_LABELS = Object.freeze({
  corrected: "Pebble CLI corrected",
  standard: "Standard / emulator raw",
  sun: "Direct sun",
  room: "Room light",
  backlight: "Backlight"
});
