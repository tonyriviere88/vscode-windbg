// A DLL the sample loads with LoadLibrary ("late" mode): it is not loaded when the debugger
// starts, so its breakpoints can only bind when it loads.
extern "C" __declspec(dllexport) int lateValue(int x) {
    int doubled = x * 2; // late value
    return doubled + 1;
}
