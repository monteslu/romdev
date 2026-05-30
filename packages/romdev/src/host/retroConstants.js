// libretro.h constants we use. Subset — extended as we need more.

export const RETRO_API_VERSION = 1;

// Devices
export const RETRO_DEVICE_NONE = 0;
export const RETRO_DEVICE_JOYPAD = 1;
export const RETRO_DEVICE_MOUSE = 2;
export const RETRO_DEVICE_KEYBOARD = 3;

// Joypad button IDs
export const RETRO_DEVICE_ID_JOYPAD_B = 0;
export const RETRO_DEVICE_ID_JOYPAD_Y = 1;
export const RETRO_DEVICE_ID_JOYPAD_SELECT = 2;
export const RETRO_DEVICE_ID_JOYPAD_START = 3;
export const RETRO_DEVICE_ID_JOYPAD_UP = 4;
export const RETRO_DEVICE_ID_JOYPAD_DOWN = 5;
export const RETRO_DEVICE_ID_JOYPAD_LEFT = 6;
export const RETRO_DEVICE_ID_JOYPAD_RIGHT = 7;
export const RETRO_DEVICE_ID_JOYPAD_A = 8;
export const RETRO_DEVICE_ID_JOYPAD_X = 9;
export const RETRO_DEVICE_ID_JOYPAD_L = 10;
export const RETRO_DEVICE_ID_JOYPAD_R = 11;
export const RETRO_DEVICE_ID_JOYPAD_L2 = 12;
export const RETRO_DEVICE_ID_JOYPAD_R2 = 13;
export const RETRO_DEVICE_ID_JOYPAD_L3 = 14;
export const RETRO_DEVICE_ID_JOYPAD_R3 = 15;
export const RETRO_DEVICE_ID_JOYPAD_MASK = 256;

// Memory regions
export const RETRO_MEMORY_SAVE_RAM = 0;
export const RETRO_MEMORY_RTC = 1;
export const RETRO_MEMORY_SYSTEM_RAM = 2;
export const RETRO_MEMORY_VIDEO_RAM = 3;

// Pixel formats
export const RETRO_PIXEL_FORMAT_0RGB1555 = 0;
export const RETRO_PIXEL_FORMAT_XRGB8888 = 1;
export const RETRO_PIXEL_FORMAT_RGB565 = 2;

// Environment commands (subset; pass-through otherwise)
export const RETRO_ENVIRONMENT_GET_OVERSCAN = 2;
export const RETRO_ENVIRONMENT_GET_CAN_DUPE = 3;
export const RETRO_ENVIRONMENT_SET_MESSAGE = 6;
export const RETRO_ENVIRONMENT_SHUTDOWN = 7;
export const RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL = 8;
export const RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY = 9;
export const RETRO_ENVIRONMENT_SET_PIXEL_FORMAT = 10;
export const RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS = 11;
export const RETRO_ENVIRONMENT_SET_KEYBOARD_CALLBACK = 12;
export const RETRO_ENVIRONMENT_GET_VARIABLE = 15;
export const RETRO_ENVIRONMENT_SET_VARIABLES = 16;
export const RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE = 17;
export const RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME = 18;
export const RETRO_ENVIRONMENT_GET_LIBRETRO_PATH = 19;
export const RETRO_ENVIRONMENT_GET_LOG_INTERFACE = 27;
export const RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY = 31;
export const RETRO_ENVIRONMENT_SET_GEOMETRY = 37;
export const RETRO_ENVIRONMENT_GET_LANGUAGE = 39;

export const RETRO_ENVIRONMENT_EXPERIMENTAL = 0x10000;
export const RETRO_ENVIRONMENT_PRIVATE = 0x20000;

// Log levels (for log_cb that we expose via GET_LOG_INTERFACE)
export const RETRO_LOG_DEBUG = 0;
export const RETRO_LOG_INFO = 1;
export const RETRO_LOG_WARN = 2;
export const RETRO_LOG_ERROR = 3;

// Sentinels
/** Video refresh data pointer meaning "GL framebuffer is valid". */
export const RETRO_HW_FRAME_BUFFER_VALID = -1 >>> 0; // unsigned -1
