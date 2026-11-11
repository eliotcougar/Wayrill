#include <stddef.h>

extern "C" void* wayrill_detours_alloc(size_t size);
extern "C" void wayrill_detours_free(void* value);

// Let MSVC emit its C++ allocation symbols for each target architecture.
void* operator new(size_t size) {
    return wayrill_detours_alloc(size);
}

void operator delete(void* value) noexcept {
    wayrill_detours_free(value);
}

void operator delete(void* value, size_t) noexcept {
    wayrill_detours_free(value);
}
