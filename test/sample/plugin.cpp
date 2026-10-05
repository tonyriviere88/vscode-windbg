// A DLL with a type the sample does not know: nothing on the sample's side needs its symbols, so
// they stay deferred unless something loads them.
namespace app {

struct Base {
    virtual ~Base() = default;
    int baseValue = 11;
};

struct PluginShape : Base {
    int sides = 5;
};

int pluginCounter = 7;

} // namespace app

extern "C" __declspec(dllexport) app::Base* makePluginObject() {
    return new app::PluginShape();
}
