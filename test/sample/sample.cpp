#include <cstdio>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <windows.h>

namespace app {

struct Point {
    int x;
    int y;
};

enum class Color { Red, Green = 5, Blue };

struct Base {
    virtual ~Base() = default;
    int baseValue = 11;
};

struct Derived : Base {
    int derivedValue = 22;
    Color color = Color::Green;
    int numbers[4] = {1, 2, 3, 4};
    char buffer[16] = "hello buf";
    std::wstring wide = L"wide string";
};

struct Shape {
    std::string name;
    std::vector<Point> points;
    std::map<std::string, int> tags;
    std::unique_ptr<Point> center;
    const wchar_t* wideLabel = L"wide label";
    double area = 0.0;
};

int globalLimit = 100;

struct Counter {
    static int instances;
    int count = 0;
    int bump(int by) {
        count += by;
        return count + instances + globalLimit; // Counter::bump
    }
};

int Counter::instances = 2;

int inspect(Derived* d, const Base& b) {
    int local = d->derivedValue + b.baseValue;
    return local;
}

int add(int a, int b) {
    int sum = a + b;
    return sum;
}

int compute(const Shape& s) {
    int total = 0;
    for (const auto& p : s.points) {
        total = add(total, p.x * p.y);
    }
    return total;
}

void thrower(int v) {
    if (v > 2) {
        throw std::runtime_error("value too large");
    }
}

void worker(int id) {
    for (int i = 0; i < 3; ++i) {
        Sleep(50);
    }
    std::printf("worker %d done\n", id);
}

volatile long spins = 0;

// Runs its loop body continuously, so a breakpoint there fires again right after continuing.
void spin(int ms) {
    ULONGLONG end = GetTickCount64() + ms;
    while (GetTickCount64() < end) {
        InterlockedIncrement(&spins);
    }
}

} // namespace app

// From plugin.dll: an app::Base whose dynamic type only the plugin's symbols describe.
extern "C" __declspec(dllimport) app::Base* makePluginObject();

int main(int argc, char** argv) {
    if (argc > 1 && std::string(argv[1]) == "spin") {
        std::thread a(app::spin, 20000);
        std::thread b(app::spin, 20000);
        app::spin(20000);
        a.join();
        b.join();
        return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "debugbreak") {
        __debugbreak();
        return 0;
    }

    app::Shape shape;
    shape.name = "triangle";
    shape.points = {{1, 2}, {3, 4}, {5, 6}};
    shape.tags["sides"] = 3;
    shape.tags["color"] = 7;
    shape.center = std::make_unique<app::Point>(app::Point{3, 4});
    shape.area = 12.5;

    app::Derived derived;
    std::string longText(300, 'x');
    int inspected = app::inspect(&derived, derived);

    app::Counter counter;
    int bumped = counter.bump(3);
    app::Base* plugged = makePluginObject();
    int pluggedValue = plugged->baseValue; // plugin object

    int result = app::compute(shape);
    std::printf("result=%d\n", result);

    try {
        app::thrower(5);
    } catch (const std::exception& e) {
        std::printf("caught: %s\n", e.what());
    }

    std::thread t1(app::worker, 1);
    std::thread t2(app::worker, 2);
    t1.join();
    t2.join();

    if (argc > 1 && std::string(argv[1]) == "wait") {
        for (int i = 0; i < 1000; ++i) {
            Sleep(100);
        }
    }
    return result == 44 ? 0 : 1;
}
