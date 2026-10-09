import * as assert from 'assert';
import { describe, it } from 'node:test';
import { isEmptyNatvis, natvisModuleRefs, neutralizeNatvis } from '../../src/adapter/natvis';

const NATVIS = `<?xml version="1.0" encoding="utf-8"?>
<AutoVisualizer xmlns="http://schemas.microsoft.com/vstudio/debugger/natvis/2010">
  <Type Name="coe2017.dll!ParamData">
    <DisplayString Condition="mParamType != 0">{mBool}</DisplayString>
  </Type>
  <Type Name="rsh::Data::HCloud">
    <Intrinsic Name="Value" Expression="((RshGeometry.dll!eastl::shared_ptr&lt;rsh::GCloud&gt;&amp;)m_Impl).mpValue" />
    <DisplayString Condition="!m_Ok">{(RshModeler!TopoDS_Shape*)m_p}</DisplayString>
    <Expand>
      <Item Name="Shape">(rshmodeler.dll!TopoDS_Shape*)this,!</Item>
    </Expand>
  </Type>
</AutoVisualizer>`;

describe('natvis', () => {
    it('lists the modules its expressions name, not the ones in type names', () => {
        assert.deepStrictEqual([...natvisModuleRefs(NATVIS)].sort(), ['rshgeometry', 'rshmodeler']);
        assert.deepStrictEqual([...natvisModuleRefs('<Type Name="A"><DisplayString>{a != b} {!c}</DisplayString></Type>')], []);
    });

    it('renames the deferred modules only, whatever their spelling', () => {
        const out = neutralizeNatvis(NATVIS, new Set(['rshmodeler']));
        assert.match(out, /\(\(RshGeometry\.dll!eastl::shared_ptr/);
        assert.match(out, /\{\(RshModeler_symbols_not_loaded!TopoDS_Shape\*\)m_p\}/);
        assert.match(out, /\(rshmodeler_symbols_not_loaded!TopoDS_Shape\*\)this,!/);
        // Type names, negations and format specifiers are untouched.
        assert.match(out, /<Type Name="coe2017\.dll!ParamData">/);
        assert.match(out, /Condition="!m_Ok"/);
        assert.match(out, /Condition="mParamType != 0"/);
        assert.strictEqual(neutralizeNatvis(NATVIS, new Set()), NATVIS);
    });

    it('tells a natvis file without visualizers', () => {
        assert.strictEqual(isEmptyNatvis(NATVIS), false);
        assert.strictEqual(isEmptyNatvis('<?xml version="1.0"?>\n<AutoVisualizer xmlns="x">\n</AutoVisualizer>'), true);
        assert.strictEqual(isEmptyNatvis('<AutoVisualizer xmlns="x"/>'), true);
        assert.strictEqual(isEmptyNatvis('<AutoVisualizer>\n  <!-- <Type Name="A"/> -->\n</AutoVisualizer>'), true);
        assert.strictEqual(isEmptyNatvis('<AutoVisualizer><UIVisualizer ServiceId="{1}" Id="1"/></AutoVisualizer>'), false);
        // Not natvis at all: cdb reports it.
        assert.strictEqual(isEmptyNatvis(''), false);
    });
});
